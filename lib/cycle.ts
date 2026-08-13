// Pure derivation for menstrual cycle tracking (issue #714). No DB/network — importable
// from the pure test tier, the query layer, and client components alike. The stored
// `cycles` rows (lib/cycle-store.ts) carry ONLY the recorded period (start/end of
// bleeding) + flow; EVERYTHING here is derived from that history:
//   • the cycle PHASE on a date (menstrual/follicular/luteal), and
//   • cycle-length + variability trends ("is it regular / changing").
//
// FORECASTING: REVERSED (issue #1679, owner ruling 2026-07-30). #714 shipped this module
// with a hard non-goal — "we NEVER predict the next period or ovulation, and there is no
// fertility-awareness / BBT logic". That exclusion is SUPERSEDED and recorded here rather
// than left to be discovered: forecastNextPeriod() below projects the next period, always
// as a CONFIDENCE-FRAMED RANGE whose width comes from the profile's own measured
// variability, and never as a bare date. #714's caution was about false confidence, and
// the answer is framing, not absence — withholding the derivation doesn't make the user's
// planning question go away, it makes them estimate worse, elsewhere.
//
// Two things #714 got right survive the reversal:
//   • The PHASE derivation stays RETROSPECTIVE. The luteal phase (the ~14-day span before
//     the NEXT period) is still only assigned once a following period is LOGGED, because
//     a phase is a claim about what the body did, not about what it will do. The forecast
//     is a separate, separately-labelled output.
//   • An `insufficient` history yields NO forecast at all. Silence is a valid output.
//
// Fertility-awareness evidence (LH / BBT / mucus) is #1680's, in lib/ttc.ts; the
// ovulation ESTIMATE here is strictly the weaker, calendar-only claim. Informational
// only, not medical advice or diagnosis, and never a contraceptive method.

import { daysBetweenDateStr, shiftDateStr } from "./date";
import { rangeContainsDate } from "./date-range";

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
  return (
    typeof v === "string" && (FLOW_LEVELS as readonly string[]).includes(v)
  );
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
// the next period). Splits a COMPLETED cycle (bounded by two logged period starts) into
// follicular vs luteal, and — since #1679 — anchors the calendar OVULATION ESTIMATE
// (projected start − 14). That second use is the weaker claim by construction: it inherits
// the projection's confidence tier and is labelled an estimate from history, never an
// observation. Evidence-based ovulation lives in lib/ttc.ts (#1680).
export const LUTEAL_PHASE_DAYS = 14;

// A commonly-cited informational threshold: cycle-length variation of more than ~7–9 days
// month-to-month is generally described as irregular. We use 7. Informational, NOT a
// diagnosis.
export const CYCLE_REGULARITY_VARIATION_DAYS = 7;

// The plausibility ceiling on an OPEN period's menstrual CLAIM (issue #1682 fix a). A
// typical period is 3–7 days; an unended one that has run past this many days is far more
// likely a forgotten "Period ended" tap than 3 weeks of bleeding. Past it the record is
// left EXACTLY as stored — nothing is written, nothing is closed — but the derivations
// stop ASSERTING `menstrual`, because that claim is no longer supported by the data
// (contact-consent: the system may withdraw a claim it makes, never rewrite what the user
// declared). The Cycle surface prompts for the real end date instead; the one-tap "Still
// bleeding" (#1681) and the dated form are the two ways to make it true again.
export const MAX_PLAUSIBLE_PERIOD_DAYS = 10;

// The shortest plausible gap, in days, between the END of one period and the START of the
// next — the offer condition for the one-tap "Period started today" (issue #1681 bug 2).
// A period ending and the next one starting are ~2–3 weeks apart, so a start tapped days
// after an end is almost always a mis-tap that would mint a back-to-back period and
// corrupt cycleLengths (which measures start-to-start). Below this gap the quick action is
// not offered and the write core refuses it; the dated history form still records the
// genuine exception, which is the right surface for one.
export const MIN_PLAUSIBLE_PERIOD_GAP_DAYS = 10;

// Bleeding days at or above which a RECORDED (ended) period is worth mentioning: typical
// is 3–7 days, so 8+ is clinically notable (issue #1682 fix b). Prolonged bleeding is real
// and important, so it is STORED as entered and never refused — only observed, calmly,
// through the coaching-tier finding in lib/cycle-observation.ts.
export const PROLONGED_PERIOD_DAYS = 8;

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

// The last day an OPEN (unended) period's menstrual claim can honestly cover: its start
// plus MAX_PLAUSIBLE_PERIOD_DAYS − 1, since the start day is day 1 (issue #1682 fix a).
export function openPeriodClaimEnd(periodStart: string): string {
  return shiftDateStr(periodStart, MAX_PLAUSIBLE_PERIOD_DAYS - 1);
}

// A recorded period as the chassis's DateRange (issue #943). The cycle domain's declared
// end-bound is INCLUSIVE — `period_end` is the last bleeding day — so bleeding-day
// membership is `rangeContainsDate(periodRange(p), date)`.
//
// An OPEN period (null `period_end`) no longer means "onward forever" (#1682 fix a): its
// claim is CAPPED at openPeriodClaimEnd, so a forgotten "Period ended" tap stops reading
// as menstrual instead of poisoning every derived read (the #718 phase-specific reference
// ranges, the Timeline day chip, the derived Period situation) indefinitely. This is the
// ONE place the cap is applied, so periodOnDate and cyclePhaseOnDate can never disagree
// about which days a period covers.
function periodRange(p: CyclePeriod) {
  return {
    start: p.period_start,
    end: p.period_end ?? openPeriodClaimEnd(p.period_start),
  };
}

// Whether an OPEN period has outrun the plausible maximum as of `date` — the "probably
// forgot to tap Period ended" state (#1682 fix a). The row is untouched and still open;
// only its menstrual claim has lapsed, which is what the Cycle surface prompts about.
export function isStaleOpenPeriod(p: CyclePeriod, date: string): boolean {
  return p.period_end == null && date > openPeriodClaimEnd(p.period_start);
}

// The recorded period that COVERS `date` as a menstrual (bleeding) day, or null. A period
// covers a date when the date is on/after its start and on/before its inclusive end; an
// ongoing period (null end) covers its first MAX_PLAUSIBLE_PERIOD_DAYS days and then stops
// claiming coverage (#1682 — see periodRange). Used for the period marker + flow on the
// Timeline/Cycle surfaces.
//
// Takes the same `today` horizon as its two twins (#2613), and for the same reason. An
// OPEN period's claim runs to openPeriodClaimEnd, which is up to nine days AHEAD of today
// — so with a period started yesterday this happily answered "yes, bleeding" for a day
// three days out. That it never reached a user is an accident of rendering:
// CyclePhaseChip early-returns on a null phase, so the phase refusal was hiding a period
// marker that had not been refused. A renderer that happens to prevent the claim is
// exactly the arrangement #2613 exists to argue against, so the refusal goes here.
export function periodOnDate(
  periods: CyclePeriod[],
  date: string,
  today: string
): CyclePeriod | null {
  if (!today) return null; // fail closed on a missing horizon — see cyclePhaseOnDate
  if (date > today) return null; // after today — unknowable, not merely uncertain
  const sorted = sortByStart(periods);
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].period_start <= date) idx = i;
    else break;
  }
  if (idx === -1) return null;
  const p = sorted[idx];
  // `idx` is the latest-started period on-or-before `date`; it covers `date` when the
  // date is within its inclusive [period_start, period_end] window (the chassis check).
  return rangeContainsDate(periodRange(p), date) ? p : null;
}

// The cycle PHASE on `date`, or null when it can't be derived (before the first recorded
// period, or after `today`). The ONE phase computation every surface formats over (the
// Cycle "current phase" card, the Timeline day chip, and the #718 phase-specific
// reference-range feed).
//
// `today` is the caller's PROFILE-LOCAL today, and it is required because the refusal
// below is the contract, not a caller's option (#2613). This derivation is retrospective
// — "what the body did" — and for any date past the last recorded period it answers
// `follicular` from the open-cycle branch. Fed a date four months out, that branch
// answered with total confidence about days nobody has lived, and the Timeline stamped a
// bare "Follicular" chip on every future goal-target day group in exactly the voice it
// uses for today. Several periods will happen in between: the phase there is not
// uncertain, it is unknowable. So a future date gets an ABSENCE — no phase, hence no
// chip — rather than a hedge; /medical/cycles already owns the honest vocabulary for
// what CAN be said about the future ("a projection from your own recorded cycles, not a
// certainty"), and that stays the only place saying it.
//
// Derivation (retrospective, non-predictive):
//   • menstrual — `date` falls within a recorded period (start..inclusive end, or an
//     ongoing period within its plausible MAX_PLAUSIBLE_PERIOD_DAYS window). Past that
//     window an unended period stops claiming menstrual and the date derives exactly as it
//     would with no open claim — follicular, or luteal once a next period is logged
//     (#1682 fix a: withdraw the claim, never rewrite the record).
//   • For a date AFTER a period's end, inside a COMPLETED cycle (a following period is
//     logged): luteal if within LUTEAL_PHASE_DAYS before the next period's start, else
//     follicular. This uses the ACTUAL next period — no forecast.
//   • For a date in the OPEN cycle (no following period yet): follicular. We do NOT claim
//     luteal here — that would mean deriving a PHASE from a PROJECTION. #1679 added the
//     projection (forecastNextPeriod), but kept it a separate, separately-labelled output:
//     a phase says what the body did, so the luteal phase still resolves only once the
//     next period is actually logged.
export function cyclePhaseOnDate(
  periods: CyclePeriod[],
  date: string,
  today: string
): CyclePhase | null {
  // Fails CLOSED on a missing horizon. `today` is typed `string`, but a union-typed
  // context or an unsound cast can still deliver undefined, and `"2026-12-10" > undefined`
  // is FALSE — so a bare `date > today` would answer the future confidently on exactly
  // the inputs that lost track of what today is. An absent horizon means the caller does
  // not know which days have been lived, and the honest answer to every date then is
  // "no phase", not "every phase".
  if (!today) return null;
  if (date > today) return null; // after today — unknowable, not merely uncertain
  const sorted = sortByStart(periods);
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].period_start <= date) idx = i;
    else break;
  }
  if (idx === -1) return null; // before any recorded period

  const p = sorted[idx];
  const next = sorted[idx + 1] ?? null;

  // Menstrual — within the recorded period's inclusive [start, end] window (`idx`
  // already guarantees period_start ≤ date). An ongoing period (null end) covers its
  // plausible window only — only ever the latest cycle.
  if (rangeContainsDate(periodRange(p), date)) return "menstrual";

  // Post-period.
  if (next != null) {
    const lutealStart = shiftDateStr(next.period_start, -LUTEAL_PHASE_DAYS);
    return date >= lutealStart ? "luteal" : "follicular";
  }
  return "follicular"; // open cycle — luteal not derivable without the next period
}

// The CYCLE DAY on `date` (1-based) — days since the start of the current cycle (the
// latest recorded period start on-or-before `date`), inclusive of the start day, so the
// first bleeding day is day 1. Null before any recorded period, and null after `today` —
// the SAME domain as cyclePhaseOnDate, deliberately. Retrospective and non-predictive:
// it counts elapsed days from a
// LOGGED start, never a forecast. The Cycle-phase dashboard card (#1221) formats
// "Cycle day N · <phase>" over this + cyclePhaseOnDate.
//
// The horizon is here for the same #2613 reason, and not because a caller feeds it a
// future date today — neither of the two does. "Cycle day 285" on a date four months out
// is the identical claim the phase chip was making: it says a cycle that started in March
// is still running in December, when several periods will have happened in between. The
// day and the phase are formatted as ONE line, so leaving the twin unguarded is how the
// hole comes back the next time a surface reaches for the day and not the phase.
export function cycleDayOnDate(
  periods: CyclePeriod[],
  date: string,
  today: string
): number | null {
  if (!today) return null; // fail closed on a missing horizon — see cyclePhaseOnDate
  if (date > today) return null; // after today — unknowable, not merely uncertain
  const sorted = sortByStart(periods);
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].period_start <= date) idx = i;
    else break;
  }
  if (idx === -1) return null; // before any recorded period
  const elapsed = daysBetweenDateStr(sorted[idx].period_start, date);
  return elapsed == null ? null : elapsed + 1; // 1-based (start day = day 1)
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
    n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
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

// ---- Next-period forecast (issue #1679) -------------------------------------
//
// The #714 non-goal reversed. Everything below derives from the SAME completed-cycle
// history cycleStats() already reads (#221: one question, one computation) — no new
// inputs, no model the evidence can't carry.

// The minimum number of COMPLETED cycles a forecast needs. Identical to the threshold
// cycleStats() uses to leave `insufficient`, deliberately: the regularity verdict and the
// forecast must never disagree about whether the history can carry a claim.
export const FORECAST_MIN_CYCLES = 3;

// The NARROWEST half-width a forecast window may have, in days (so the tightest possible
// regular history still reads "±2 days", never a bare date). A range is the unit of the
// claim; a point estimate would be a lie the data can't back.
export const FORECAST_MIN_HALF_WIDTH_DAYS = 2;

// The WIDEST half-width, in days. Past ~±10 days a "window" spans most of a cycle and
// stops being information; the confidence tier and the evidence line carry the honesty
// from there.
export const FORECAST_MAX_HALF_WIDTH_DAYS = 10;

// How confident the projection is — the tier every surface labels itself with.
//   narrow    — a `regular` history (spread within CYCLE_REGULARITY_VARIATION_DAYS).
//   wide      — an `irregular` history; the window is explicitly wide and says so.
//   uncertain — the CURRENT cycle has already outrun its own projected window. The
//               forecast is NOT re-projected onto a new date (that would be confidently
//               predicting from the one cycle we can see is atypical); the window widens
//               to cover the overrun and the confidence degrades. Widen, never shift.
export type ForecastConfidence = "narrow" | "wide" | "uncertain";

// Why a profile gets no forecast at all even with plenty of history. Both are states in
// which a projected period is meaningless, so silence is the only honest output.
//   pregnancy       — an ongoing pregnancy (#1402 will make this episode-derived; today
//                     it is the shipped `risk_pregnant` profile attribute).
//   postmenopausal  — an explicit reproductive status of postmenopausal.
export type ForecastSuspension = "pregnancy" | "postmenopausal";

// The evidence the projection stands on, carried on the result so EVERY surface can
// explain itself from the one computation instead of re-deriving a justification.
export interface ForecastEvidence {
  cycleCount: number; // completed cycles used
  meanLength: number; // rounded to 1 decimal, as cycleStats reports it
  variabilityDays: number; // max − min over the window
  regularity: CycleRegularity;
  lastPeriodStart: string; // the anchor the projection counts from
}

export type CycleForecast =
  | {
      kind: "forecast";
      // The projected first day — the CENTRE of the window, never rendered alone.
      projectedStart: string;
      // The inclusive window [windowStart, windowEnd] the period is expected in.
      windowStart: string;
      windowEnd: string;
      halfWidthDays: number;
      confidence: ForecastConfidence;
      // True once `today` is past windowEnd: the current cycle has outrun the window,
      // which is why the confidence degraded and the window grew.
      overdue: boolean;
      // The CALENDAR ovulation estimate: projectedStart − LUTEAL_PHASE_DAYS, carrying the
      // same window width and the same confidence tier. Strictly the weaker claim — an
      // estimate from history, never an observation (#1680 supplies the evidence-based
      // one). Null when the estimate would fall on/before the anchoring period start,
      // i.e. the arithmetic no longer describes this cycle.
      ovulationEstimate: {
        estimatedDate: string;
        windowStart: string;
        windowEnd: string;
      } | null;
      evidence: ForecastEvidence;
    }
  | {
      // Too few completed cycles. No date, no window — "log a couple more cycles".
      kind: "insufficient";
      cycleCount: number;
    }
  | { kind: "suspended"; reason: ForecastSuspension };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// The window half-width in days, from measured variability alone. MONOTONIC in variation
// by construction (ceil of half the spread, clamped), so more variable history can only
// ever produce a wider — never a narrower — claim, and the tightest history still gets a
// range rather than a date.
export function forecastHalfWidthDays(variabilityDays: number): number {
  return clamp(
    Math.ceil(variabilityDays / 2),
    FORECAST_MIN_HALF_WIDTH_DAYS,
    FORECAST_MAX_HALF_WIDTH_DAYS
  );
}

// THE forecast (#1679). Pure: the recorded period history, the profile's today, and an
// optional suspension the caller gathered. Every consumer — the Cycle surface, the
// dashboard tile — formats THIS result; none of them re-derives a projection.
//
// Order matters: suspension beats everything (a projected period during a pregnancy is
// noise at best), then sufficiency, then the projection itself.
export function forecastNextPeriod(
  periods: CyclePeriod[],
  today: string,
  suspension: ForecastSuspension | null = null
): CycleForecast {
  if (suspension) return { kind: "suspended", reason: suspension };

  const stats = cycleStats(periods);
  const sorted = sortByStart(periods);
  const last = sorted[sorted.length - 1];
  if (
    stats.cycleCount < FORECAST_MIN_CYCLES ||
    stats.meanLength == null ||
    stats.variabilityDays == null ||
    last == null
  ) {
    return { kind: "insufficient", cycleCount: stats.cycleCount };
  }

  const halfWidth = forecastHalfWidthDays(stats.variabilityDays);
  const projectedStart = shiftDateStr(
    last.period_start,
    Math.round(stats.meanLength)
  );
  const windowStart = shiftDateStr(projectedStart, -halfWidth);
  const baseWindowEnd = shiftDateStr(projectedStart, halfWidth);

  // The current cycle has outrun its own window. Degrade, don't re-predict: the projected
  // start and the window START stay exactly where the history put them, and only the END
  // stretches to cover the days actually elapsed.
  const overdue = today > baseWindowEnd;
  const windowEnd = overdue ? today : baseWindowEnd;
  const confidence: ForecastConfidence = overdue
    ? "uncertain"
    : stats.regularity === "regular"
      ? "narrow"
      : "wide";

  // Calendar ovulation estimate — the same window shifted back by the luteal span. Drop it
  // when it lands on or before the anchoring period start: past that the subtraction is
  // describing the PREVIOUS cycle, and a wrong-cycle estimate is worse than none.
  const estimatedDate = shiftDateStr(projectedStart, -LUTEAL_PHASE_DAYS);
  const ovulationEstimate =
    estimatedDate > last.period_start
      ? {
          estimatedDate,
          windowStart: shiftDateStr(windowStart, -LUTEAL_PHASE_DAYS),
          windowEnd: shiftDateStr(baseWindowEnd, -LUTEAL_PHASE_DAYS),
        }
      : null;

  return {
    kind: "forecast",
    projectedStart,
    windowStart,
    windowEnd,
    halfWidthDays: halfWidth,
    confidence,
    overdue,
    ovulationEstimate,
    evidence: {
      cycleCount: stats.cycleCount,
      meanLength: stats.meanLength,
      variabilityDays: stats.variabilityDays,
      regularity: stats.regularity,
      lastPeriodStart: last.period_start,
    },
  };
}

// The one confidence LABEL every surface renders, so the tier can't be described two ways.
export const FORECAST_CONFIDENCE_LABELS: Record<ForecastConfidence, string> = {
  narrow: "Narrow window",
  wide: "Wide window — your cycles vary",
  uncertain: "Less certain — this cycle is running long",
};
