// Pure, CITED field-test estimators for the guided Fitness check (issue #834).
//
// The fitness-norms engine (lib/fitness-norms.ts) scores a VO2 Max value against
// age/sex percentiles, but a household user rarely has a lab CPET number. These pure
// functions turn a FIELD test the user can self-administer into an estimated VO2 Max
// (mL/kg/min), which then feeds the norms engine and the "VO2 Max" natural store exactly
// like a watch-reported value. Every formula is a PUBLISHED regression — the same
// citation discipline as the baked datasets. No DB, no network; unit-tested in
// lib/__tests__.
//
// A note on the "3-minute step test": the issue references the YMCA 3-minute step test,
// whose published protocol yields a 1-minute recovery HEART RATE mapped to a fitness
// CATEGORY, not a direct VO2 regression. The step test that DOES yield a cited VO2
// estimate is the Queens College Step Test (McArdle 1972), a 3-minute step with a
// sex-specific recovery-HR → VO2max regression. We implement that (labeled accurately)
// so the step option produces a real VO2 number, and separately expose the 1-minute
// heart-rate recovery capture (`heartRateRecovery`) that rides any stepping/HR-strapped
// effort. Callers surface the Queens College protocol details in the test instructions.

import type { Sex } from "@/lib/types";

// Plausible VO2 Max envelope (mL/kg/min) for a human. Field regressions can extrapolate
// past the sane range on extreme inputs; we clamp so a mistyped distance/time can't
// store an absurd value. (An elite endurance athlete tops out near 90; a frail adult
// floors near 10.)
const VO2_MIN = 10;
const VO2_MAX = 90;

function clampVo2(v: number): number {
  return Math.max(VO2_MIN, Math.min(VO2_MAX, Math.round(v * 10) / 10));
}

// A resolved field-test VO2 estimate: the value (canonical mL/kg/min) plus the cited
// method it came from, for the entry's raw-input record and the surface's provenance
// line. Null from every estimator when an input is missing/non-finite/non-positive —
// the caller then hides the result rather than storing a guess.
export interface Vo2Estimate {
  vo2: number;
  method: string;
  citation: string;
}

// ── Cooper 12-minute run/walk ────────────────────────────────────────────────────
// VO2max = (distance_m − 504.9) / 44.73. Cooper KH, "A means of assessing maximal
// oxygen intake," JAMA 1968;203(3):201-204. `distanceMeters` = distance covered in 12
// minutes.
export function cooperVo2(distanceMeters: number | null | undefined): Vo2Estimate | null {
  if (distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters <= 0)
    return null;
  return {
    vo2: clampVo2((distanceMeters - 504.9) / 44.73),
    method: "Cooper 12-minute run",
    citation: "Cooper, JAMA 1968;203(3):201-204.",
  };
}

// ── Rockport 1-mile walk test ────────────────────────────────────────────────────
// VO2max = 132.853 − 0.0769·weight_lb − 0.3877·age + 6.315·sexMale − 3.2649·time_min
//          − 0.1565·HR. Kline GM et al., "Estimation of VO2max from a one-mile track
// walk...," Med Sci Sports Exerc 1987;19(3):253-259. `timeMin` = walk time (minutes),
// `heartRate` = HR (bpm) at the end of the mile. Sex enters as 1 (male) / 0 (female).
export function rockportWalkVo2(input: {
  weightLb: number | null | undefined;
  age: number | null | undefined;
  sex: Sex | null | undefined;
  timeMin: number | null | undefined;
  heartRate: number | null | undefined;
}): Vo2Estimate | null {
  const { weightLb, age, sex, timeMin, heartRate } = input;
  if (
    weightLb == null || !Number.isFinite(weightLb) || weightLb <= 0 ||
    age == null || !Number.isFinite(age) || age <= 0 ||
    !sex ||
    timeMin == null || !Number.isFinite(timeMin) || timeMin <= 0 ||
    heartRate == null || !Number.isFinite(heartRate) || heartRate <= 0
  )
    return null;
  const sexMale = sex === "male" ? 1 : 0;
  const vo2 =
    132.853 -
    0.0769 * weightLb -
    0.3877 * age +
    6.315 * sexMale -
    3.2649 * timeMin -
    0.1565 * heartRate;
  return {
    vo2: clampVo2(vo2),
    method: "Rockport 1-mile walk",
    citation: "Kline et al., Med Sci Sports Exerc 1987;19(3):253-259.",
  };
}

// ── Queens College 3-minute step test ────────────────────────────────────────────
// VO2max = 111.33 − 0.42·recoveryHR (men); 65.81 − 0.1847·recoveryHR (women), where
// recoveryHR (bpm) is the post-step recovery heart rate. McArdle WD et al., "Reliability
// and interrelationships between maximal oxygen intake, physical work capacity and step-
// test scores in college women," Med Sci Sports 1972;4(4):182-186. Protocol: 16.25-inch
// (41.3 cm) step, 24 steps/min men / 22 steps/min women, 3 minutes; recovery HR taken
// 5-20 s after finishing.
export function queensStepVo2(
  recoveryHr: number | null | undefined,
  sex: Sex | null | undefined
): Vo2Estimate | null {
  if (recoveryHr == null || !Number.isFinite(recoveryHr) || recoveryHr <= 0 || !sex)
    return null;
  const vo2 =
    sex === "male" ? 111.33 - 0.42 * recoveryHr : 65.81 - 0.1847 * recoveryHr;
  return {
    vo2: clampVo2(vo2),
    method: "Queens College 3-minute step test",
    citation: "McArdle et al., Med Sci Sports 1972;4(4):182-186.",
  };
}

// ── 1-minute heart-rate recovery (HRR) ───────────────────────────────────────────
// HRR = peak HR − HR one minute into recovery. A cited autonomic-recovery marker: a
// 1-minute recovery ≤ 12 bpm predicts higher all-cause mortality (Cole CR et al.,
// "Heart-rate recovery immediately after exercise as a predictor of mortality," N Engl J
// Med 1999;341(18):1351-1357). This is NOT a percentile — it carries its own published
// band, exactly like the SRT below. Rides any HR-strapped effort (e.g. the step test).
export type HrrBand = "abnormal" | "normal";

export interface HrrResult {
  hrr: number; // bpm dropped in the first minute
  band: HrrBand;
  citation: string;
}

// Abnormal cutoff (≤ 12 bpm) from Cole 1999 (non-graded/active-recovery protocol).
export const HRR_ABNORMAL_CUTOFF = 12;

export function heartRateRecovery(
  peakHr: number | null | undefined,
  oneMinuteHr: number | null | undefined
): HrrResult | null {
  if (
    peakHr == null || !Number.isFinite(peakHr) || peakHr <= 0 ||
    oneMinuteHr == null || !Number.isFinite(oneMinuteHr) || oneMinuteHr <= 0
  )
    return null;
  const hrr = Math.round(peakHr - oneMinuteHr);
  return {
    hrr,
    band: hrr <= HRR_ABNORMAL_CUTOFF ? "abnormal" : "normal",
    citation: "Cole et al., N Engl J Med 1999;341(18):1351-1357.",
  };
}

// ── Sitting-Rising Test (SRT) ─────────────────────────────────────────────────────
// A 0-10 musculoskeletal-fitness score (sitting 0-5 + rising 0-5; subtract 1 per hand/
// knee/forearm/leg-side support used, 0.5 per loss of balance). Its OWN published scale,
// never a percentile: a composite score < 8 is associated with higher all-cause
// mortality (Brito LBB, Araújo CGS et al., "Ability to sit and rise from the floor as a
// predictor of all-cause mortality," Eur J Prev Cardiol 2014;21(7):892-898). The user
// enters the final 0-10 score; we validate it and band it.
export type SrtBand = "elevated-risk" | "intermediate" | "reference";

export interface SrtResult {
  score: number; // 0-10, half-point resolution
  band: SrtBand;
  citation: string;
}

// Score bands from Brito/Araújo 2014: <8 elevated risk, 8-9.5 intermediate, 10 reference.
export function sittingRisingBand(score: number): SrtBand {
  if (score < 8) return "elevated-risk";
  if (score < 10) return "intermediate";
  return "reference";
}

export function sittingRisingResult(score: number | null | undefined): SrtResult | null {
  if (score == null || !Number.isFinite(score) || score < 0 || score > 10) return null;
  // Snap to the test's half-point resolution.
  const snapped = Math.round(score * 2) / 2;
  return {
    score: snapped,
    band: sittingRisingBand(snapped),
    citation: "Brito/Araújo, Eur J Prev Cardiol 2014;21(7):892-898.",
  };
}
