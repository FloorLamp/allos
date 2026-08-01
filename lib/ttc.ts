// Trying-to-conceive: the PURE half (issue #1680). No DB/network — importable from the
// pure test tier, the query layer, and client components alike. The DB gather/write cores
// live in lib/ttc-store.ts; the coaching finding is assembled in lib/rule-findings.ts.
//
// THREE OBSERVATIONS, NO NEW TABLE. Per the "reuse an existing store" rule, every TTC
// reading is a vocabulary extension of a shipped observation store:
//
//   LH test        → medical_records  (a dated test result with a value/interpretation)
//   BBT            → metric_samples   (a daily waking temperature, canonical °F)
//   Cervical mucus → symptom_logs     (a categorical daily observation, ordinal 1–4)
//
// WHAT THIS MODULE WILL NOT DO. No fertility SCORE and no "chance today" percentage: the
// app states the evidence it has and the window that evidence supports, and manufactures
// no probability it cannot support. No streaks, no gamification, no encouraging-tone
// milestones (the #716/#992 sensitivity precedent) — TTC is frequently a period of grief,
// and a cycle that ends without a pregnancy is a neutral fact here, never a failure line.
//
// NOT CONTRACEPTION. Every fertile-window rendering carries NOT_CONTRACEPTION_NOTE. This
// is non-negotiable copy, and the constant exists so no surface can paraphrase it away.

import { ageInMonthsFromBirthdate, daysBetweenDateStr, shiftDateStr } from "./date";

// The line every fertile-window rendering carries, verbatim.
export const NOT_CONTRACEPTION_NOTE =
  "This is not a contraceptive method — a fertile window is an estimate, not a boundary.";

// ---- Vocabulary: where each observation lives -------------------------------

// medical_records.name for a home ovulation (urine LH) test. Deliberately NOT the
// canonical serum "LH" biomarker: a urine strip is a qualitative surge indicator, and
// filing it under the serum analyte would flag it against serum reference ranges. The row
// carries no canonical_name for exactly that reason.
export const LH_TEST_RECORD_NAME = "Ovulation Test (LH)";

// metric_samples.metric for the waking temperature. Canonical storage is °F — the app has
// ONE canonical temperature scale (lib/units.ts) and a second one here would fork the
// conversion the units rule exists to prevent. The login's temperature preference converts
// at the DISPLAY boundary only, through the shared fmtTemp.
export const BBT_METRIC = "bbt_f";

// symptom_logs.symptom for the daily mucus observation. Curated in lib/symptoms.json with
// its OWN ordinal scale, so the stored 1–4 never renders as "mild → very severe".
export const CERVICAL_MUCUS_SYMPTOM = "cervical_mucus";

export type LhResult = "positive" | "negative";

export function isLhResult(v: unknown): v is LhResult {
  return v === "positive" || v === "negative";
}

// The categorical mucus vocabulary, in ASCENDING fertility-signal order — which is also
// the stored symptom_logs severity ordinal (1–4), so the ordering is the storage.
export type MucusQuality = "dry" | "sticky" | "creamy" | "egg_white";

export const MUCUS_QUALITIES: readonly MucusQuality[] = [
  "dry",
  "sticky",
  "creamy",
  "egg_white",
];

export const MUCUS_LABELS: Record<MucusQuality, string> = {
  dry: "Dry",
  sticky: "Sticky",
  creamy: "Creamy",
  egg_white: "Egg-white",
};

// quality → the stored 1–4 ordinal, and back. ONE mapping, both directions, so a write and
// a read can never disagree about what a stored 3 meant.
export function mucusOrdinal(q: MucusQuality): number {
  return MUCUS_QUALITIES.indexOf(q) + 1;
}

export function mucusFromOrdinal(n: number): MucusQuality | null {
  return MUCUS_QUALITIES[n - 1] ?? null;
}

export function isMucusQuality(v: unknown): v is MucusQuality {
  return (
    typeof v === "string" && (MUCUS_QUALITIES as readonly string[]).includes(v)
  );
}

// The qualities that indicate the fertile phase. Creamy and egg-white are the transudative
// pattern; dry and sticky are not. Ordinal ≥ this, so the threshold is one comparison.
export const FERTILE_MUCUS_MIN_ORDINAL = mucusOrdinal("creamy");

export function isFertileMucus(q: MucusQuality): boolean {
  return mucusOrdinal(q) >= FERTILE_MUCUS_MIN_ORDINAL;
}

// ---- Fertile window (Part 2) ------------------------------------------------

// An LH surge precedes ovulation by roughly 24–36 hours, so a positive today puts
// ovulation inside the next two days. The window is "now", which is the whole point of the
// test being the strongest PREDICTIVE signal.
export const LH_SURGE_TO_OVULATION_DAYS = 2;

// How stale a positive LH test may be and still describe the CURRENT window. A surge two
// days old has already resolved into ovulation.
export const LH_POSITIVE_MAX_AGE_DAYS = 1;

// Fertile-quality mucus indicates the approach of ovulation but doesn't time it, so its
// window runs a little longer and is a weaker claim than the surge.
export const MUCUS_FERTILE_WINDOW_DAYS = 3;
export const MUCUS_MAX_AGE_DAYS = 1;

// The classic fertile span around ovulation: sperm survive ~5 days, the ovum ~1.
export const FERTILE_DAYS_BEFORE_OVULATION = 5;
export const FERTILE_DAYS_AFTER_OVULATION = 1;

// Which evidence the window was built from — ALWAYS reported, so the user can see why the
// app is as confident as it is (and why a calendar-only window is the weakest of the four
// standard methods).
export type FertileEvidence = "lh" | "mucus" | "calendar";

export const FERTILE_EVIDENCE_LABELS: Record<FertileEvidence, string> = {
  lh: "Positive LH test",
  mucus: "Cervical mucus",
  calendar: "Calendar estimate",
};

export interface FertileWindow {
  start: string; // inclusive
  end: string; // inclusive
  evidence: FertileEvidence;
  // The observation (or projection) the window was anchored on.
  basisDate: string;
  detail: string;
}

export interface DatedLhTest {
  date: string;
  result: LhResult;
}

export interface DatedMucus {
  date: string;
  quality: MucusQuality;
}

export interface FertileWindowInput {
  today: string;
  lhTests: DatedLhTest[];
  mucus: DatedMucus[];
  // The CALENDAR ovulation estimate from the #1679 forecast, already confidence-framed.
  // Null when the history can't carry one — then there is simply no calendar fallback.
  calendarOvulation: {
    estimatedDate: string;
    windowStart: string;
    windowEnd: string;
  } | null;
  // No fertile window at all while a pregnancy is ongoing (the #1402 handoff).
  suspended?: boolean;
}

function ageInDays(from: string, to: string): number | null {
  const d = daysBetweenDateStr(from, to);
  return d == null ? null : d;
}

// The fertile window from the BEST available evidence, ranked LH > mucus > calendar, or
// null. ONE computation — the Cycle surface and any future consumer format this result and
// never re-rank for themselves.
//
// The ranking is the clinical one: a positive LH test times ovulation to within a day or
// two; a mucus pattern says the window is open but not when it closes; a calendar estimate
// only says what a typical cycle of this length would do. Reporting WHICH was used is the
// honesty mechanism — a calendar-only window looks different, and should.
export function fertileWindow(input: FertileWindowInput): FertileWindow | null {
  if (input.suspended) return null;
  const { today } = input;

  // 1. LH-positive — the strongest predictive signal.
  const positives = input.lhTests
    .filter((t) => t.result === "positive")
    .filter((t) => {
      const age = ageInDays(t.date, today);
      return age != null && age >= 0 && age <= LH_POSITIVE_MAX_AGE_DAYS;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const surge = positives[0];
  if (surge) {
    return {
      start: surge.date,
      end: shiftDateStr(surge.date, LH_SURGE_TO_OVULATION_DAYS),
      evidence: "lh",
      basisDate: surge.date,
      detail:
        `A positive LH test on ${surge.date} usually precedes ovulation by about ` +
        `24–36 hours, so the window is open now.`,
    };
  }

  // 2. Fertile-quality mucus — real-time, and the observation that costs nothing.
  const fertileMucus = input.mucus
    .filter((m) => isFertileMucus(m.quality))
    .filter((m) => {
      const age = ageInDays(m.date, today);
      return age != null && age >= 0 && age <= MUCUS_MAX_AGE_DAYS;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const mucusObs = fertileMucus[0];
  if (mucusObs) {
    return {
      start: mucusObs.date,
      end: shiftDateStr(mucusObs.date, MUCUS_FERTILE_WINDOW_DAYS),
      evidence: "mucus",
      basisDate: mucusObs.date,
      detail:
        `${MUCUS_LABELS[mucusObs.quality]} cervical mucus on ${mucusObs.date} is a ` +
        `fertile-phase pattern. It shows the window is open, but doesn't time ovulation.`,
    };
  }

  // 3. Calendar estimate — the weakest of the four standard methods, and labelled so.
  const cal = input.calendarOvulation;
  if (cal) {
    return {
      start: shiftDateStr(cal.windowStart, -FERTILE_DAYS_BEFORE_OVULATION),
      end: shiftDateStr(cal.windowEnd, FERTILE_DAYS_AFTER_OVULATION),
      evidence: "calendar",
      basisDate: cal.estimatedDate,
      detail:
        `Estimated from your recorded cycle lengths alone — no LH test or mucus ` +
        `observation is informing this window. Log one to narrow it.`,
    };
  }
  return null;
}

// ---- Ovulation confirmation from BBT (Part 2) -------------------------------
//
// RETROSPECTIVE BY NATURE. A sustained temperature rise says ovulation ALREADY happened;
// it can never be presented as a prediction. That is why it lives apart from
// fertileWindow() above and returns a past date.

// How many readings form the pre-rise baseline (the classic "3 over 6" rule).
export const BBT_BASELINE_READINGS = 6;

// How many consecutive readings must stay above the baseline for the rise to count.
export const BBT_RISE_SUSTAINED_READINGS = 3;

// The rise, in canonical °F, at least one sustained reading must clear above the baseline
// maximum. Below this a "rise" is measurement noise (waking time, thermometer, a poor
// night). 0.4 °F is the classic threshold — the same number as the ~0.2 °C usually quoted.
export const BBT_RISE_THRESHOLD_F = 0.4;

// The fewest baseline readings that make the comparison honest. Gaps are normal — people
// miss mornings — so the rule works over READINGS, not calendar days; but a "baseline" of
// two temperatures is not a baseline.
export const BBT_MIN_BASELINE_READINGS = 4;

export interface DatedTemperature {
  date: string;
  degF: number; // canonical °F
}

export interface OvulationConfirmation {
  // The estimated ovulation day: the reading BEFORE the first sustained high one.
  ovulationDate: string;
  firstHighDate: string;
  baselineF: number; // the pre-rise maximum the rise is measured against, canonical °F
  riseF: number; // the largest sustained reading minus the baseline, rounded to 2dp
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Confirm ovulation from a series of waking temperatures — the EARLIEST sustained rise in
// the series. Pure; readings may arrive in any order and may have missing days.
//
// The rule (classic "3 over 6", gap-tolerant): for each candidate index i, take the up-to-
// BBT_BASELINE_READINGS readings before it; require at least BBT_MIN_BASELINE_READINGS of
// them; require the next BBT_RISE_SUSTAINED_READINGS readings to ALL exceed that
// baseline's maximum; and require at least one of them to clear it by BBT_RISE_THRESHOLD_F.
// Estimated ovulation is the reading immediately BEFORE the first high one.
export function confirmOvulation(
  readings: DatedTemperature[]
): OvulationConfirmation | null {
  const sorted = [...readings].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  for (let i = BBT_MIN_BASELINE_READINGS; i < sorted.length; i++) {
    const baseline = sorted.slice(Math.max(0, i - BBT_BASELINE_READINGS), i);
    if (baseline.length < BBT_MIN_BASELINE_READINGS) continue;
    const high = sorted.slice(i, i + BBT_RISE_SUSTAINED_READINGS);
    if (high.length < BBT_RISE_SUSTAINED_READINGS) break; // not enough readings yet
    const baselineMax = Math.max(...baseline.map((r) => r.degF));
    if (!high.every((r) => r.degF > baselineMax)) continue;
    const rise = Math.max(...high.map((r) => r.degF)) - baselineMax;
    if (rise < BBT_RISE_THRESHOLD_F) continue;
    return {
      ovulationDate: sorted[i - 1].date,
      firstHighDate: sorted[i].date,
      baselineF: round2(baselineMax),
      riseF: round2(rise),
    };
  }
  return null;
}

// ---- Luteal-phase length ----------------------------------------------------

// Days from a CONFIRMED ovulation to the next period start — the clinically interesting
// number a short luteal phase shows up in. Null when there is no next period yet or the
// dates don't describe a forward interval.
export function lutealPhaseLengthDays(
  ovulationDate: string,
  nextPeriodStart: string
): number | null {
  const d = daysBetweenDateStr(ovulationDate, nextPeriodStart);
  return d == null || d <= 0 ? null : d;
}

// A luteal phase this short or shorter is the pattern worth raising with a clinician.
// Stated as an observation on the Cycle surface — never a diagnosis, never a push.
export const SHORT_LUTEAL_PHASE_DAYS = 10;

// ---- Day-21 progesterone timing (Part 2) ------------------------------------
//
// The existing cycle-phase range machinery (`ranges_by_cycle_phase`, luteal) already
// INTERPRETS a progesterone result; all this adds is legibility about when it was drawn.

// The mid-luteal draw a "day 21 progesterone" is really asking for: about a week after
// ovulation, not literally cycle day 21.
export const PROGESTERONE_DRAW_DAYS_AFTER_OVULATION = 7;

// How far from that ideal a draw can be and still read as mid-luteal.
export const PROGESTERONE_DRAW_TOLERANCE_DAYS = 2;

export interface ProgesteroneTiming {
  daysAfterOvulation: number;
  midLuteal: boolean; // within tolerance of the ideal mid-luteal draw
  note: string;
}

// Describe WHEN a progesterone result was drawn relative to a confirmed ovulation. Null
// when the draw precedes ovulation (there is nothing luteal to say about it).
export function progesteroneTiming(
  drawnDate: string,
  ovulationDate: string
): ProgesteroneTiming | null {
  const d = daysBetweenDateStr(ovulationDate, drawnDate);
  if (d == null || d < 0) return null;
  const off = Math.abs(d - PROGESTERONE_DRAW_DAYS_AFTER_OVULATION);
  const midLuteal = off <= PROGESTERONE_DRAW_TOLERANCE_DAYS;
  return {
    daysAfterOvulation: d,
    midLuteal,
    note: midLuteal
      ? `Drawn ${d} days after estimated ovulation — a mid-luteal draw, which is what a "day 21" progesterone is asking for.`
      : `Drawn ${d} days after estimated ovulation, outside the usual mid-luteal window (about ${PROGESTERONE_DRAW_DAYS_AFTER_OVULATION} days), so read it with that in mind.`,
  };
}

// ---- Months-trying counter (Part 2) -----------------------------------------
//
// DECLARED ONLY. The start date is the user's statement, never inferred from behavior
// (the declared-only doctrine): logging an LH test is not a declaration of intent, and
// the app must never decide on someone's behalf that they are trying to conceive.

export interface TryingDuration {
  months: number; // whole elapsed calendar months
  days: number; // elapsed days
  cyclesAttempted: number; // recorded period starts on/after the declared start
}

// Elapsed time since the declared start. Reuses ageInMonthsFromBirthdate for the calendar
// month arithmetic — it is generic whole-month math, and a second implementation would be
// a second answer to one question (#221). Null for an unparseable or future start.
export function tryingDuration(
  ttcStart: string,
  today: string,
  periodStarts: string[] = []
): TryingDuration | null {
  const days = daysBetweenDateStr(ttcStart, today);
  if (days == null || days < 0) return null;
  const months = ageInMonthsFromBirthdate(ttcStart, today);
  if (months == null) return null;
  return {
    months,
    days,
    cyclesAttempted: periodStarts.filter((d) => d >= ttcStart).length,
  };
}

// ---- The workup prompt (Part 3) ---------------------------------------------

// dedupeKey namespace for the suppression bus + the RULE_FINDING_PREFIXES registry.
export const TTC_WORKUP_PREFIX = "ttc-workup:";

// The standard thresholds for suggesting a fertility conversation: 12 months of trying,
// or 6 months from age 35 — the age at which the usual advice shortens.
export const TTC_WORKUP_MONTHS = 12;
export const TTC_WORKUP_MONTHS_OLDER = 6;
export const TTC_WORKUP_OLDER_AGE = 35;

// How many months of trying earn the prompt for this profile. An unknown age gets the
// LONGER threshold — the calm default when the app doesn't know.
export function workupThresholdMonths(age: number | null): number {
  return age != null && age >= TTC_WORKUP_OLDER_AGE
    ? TTC_WORKUP_MONTHS_OLDER
    : TTC_WORKUP_MONTHS;
}

// The episode key: the DECLARED start. Dismissing silences this TTC episode's prompt; a
// later, separately declared attempt surfaces its own ("dismiss once, silence until it
// changes", #436) — never a topic-wide mute.
export function ttcWorkupSignalKey(ttcStart: string): string {
  return `${TTC_WORKUP_PREFIX}${ttcStart}`;
}

export interface WorkupPrompt {
  dedupeKey: string;
  months: number;
  thresholdMonths: number;
  title: string;
  detail: string;
}

export interface WorkupPromptInput {
  ttcStart: string | null; // declared start, or null (nothing declared → no prompt)
  today: string;
  age: number | null;
  pregnant?: boolean; // an ongoing pregnancy stops TTC surfaces entirely
}

// The calm, dismissible coaching-tier prompt at the threshold. NEVER a push, never an
// escalation. The copy is deliberately flat: it states elapsed time and that a clinician
// conversation is the usual next step. No cause, no odds, no reassurance, no "keep going"
// — a fertility timeline is not a performance, and this is not a milestone.
export function decideWorkupPrompt(
  input: WorkupPromptInput
): WorkupPrompt | null {
  if (!input.ttcStart || input.pregnant) return null;
  const dur = tryingDuration(input.ttcStart, input.today);
  if (!dur) return null;
  const threshold = workupThresholdMonths(input.age);
  if (dur.months < threshold) return null;
  const olderRule = threshold === TTC_WORKUP_MONTHS_OLDER;
  return {
    dedupeKey: ttcWorkupSignalKey(input.ttcStart),
    months: dur.months,
    thresholdMonths: threshold,
    title: `${dur.months} months of trying — a clinician conversation is the usual next step`,
    detail:
      `You recorded ${input.ttcStart} as when you started trying. A fertility ` +
      `evaluation is commonly suggested after ${threshold} months` +
      (olderRule ? ` from age ${TTC_WORKUP_OLDER_AGE}` : "") +
      `. Informational only — not a diagnosis, and not a statement about your chances.`,
  };
}
