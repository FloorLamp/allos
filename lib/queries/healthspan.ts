// Server-side assembly for the healthspan pillars widget (issue #161). This is a
// pure DB SEAM: it gathers each pillar's inputs from the ALREADY-MERGED
// computations (fitness percentile #158, sleep regularity #160, PhenoAge
// #157/#209, and the curated optimal ranges) and hands them to the pure
// buildPillars — it never re-derives any of those numbers, so a pillar's headline
// equals its source computation for the same data ("one question, one
// computation"). Every read goes through an already profile-scoped query, so no
// `.prepare` lives here and the scoping guard is unaffected.

import { getUserSex, getUserAge } from "../settings";
import {
  getLatestMedicalRecordByCanonical,
  getMedicalRecords,
  getCanonicalBiomarker,
} from "./medical";
import { getBioAgeReadings } from "./derived";
import { getSleepRegularity, getSleepRegularityTrend } from "./sleep";
import { getLatestBodyMetric } from "./metrics";
import { getStrengthByExercise } from "./training";
import { fitnessContext } from "../fitness-norms";
import { strengthStanding, bestStanding } from "../strength-standards";
import { bioAgeDelta, isBioAgeHiddenForAge } from "../bio-age";
import {
  buildPillars,
  optimalRangeHitRate,
  type BiomarkerReading,
  type Pillar,
  type PillarInputs,
  type PillarTrend,
} from "../healthspan-pillars";

// Lab-ish categories the optimal-range pillar counts (parity with the recent-labs
// widget): actual labs/biomarkers, not vitals/scans/prescriptions.
const LAB_CATEGORIES = new Set(["lab", "biomarker"]);

const VO2_MARKER = "VO2 Max";

function sriTrendArrow(profileId: number): PillarTrend | null {
  const trend = getSleepRegularityTrend(profileId);
  if (trend.length < 2) return null;
  const last = trend[trend.length - 1].sri;
  const prev = trend[trend.length - 2].sri;
  const delta = Number((last - prev).toFixed(1));
  if (delta === 0) return { direction: "flat", label: "steady" };
  return {
    direction: delta > 0 ? "up" : "down",
    label: `${delta > 0 ? "+" : "−"}${Math.abs(delta)} vs last`,
  };
}

// The visible healthspan pillars for a profile. Each input is gathered
// independently and only supplied to buildPillars when it's present, so a pillar
// with no data (age/sex unset, no readings, child-gated bio-age) simply doesn't
// appear — pillars hide when their data is absent, no composite score.
export function getHealthspanPillars(profileId: number): Pillar[] {
  const sex = getUserSex(profileId);
  const age = getUserAge(profileId);

  const inputs: PillarInputs = {};

  // VO2 Max percentile (#158) — from the latest VO2 Max reading + fitnessContext.
  const vo2 = getLatestMedicalRecordByCanonical(profileId, VO2_MARKER);
  const vo2ctx =
    vo2?.value_num != null
      ? fitnessContext(VO2_MARKER, vo2.value_num, sex, age)
      : null;
  if (vo2ctx) {
    inputs.vo2 = {
      percentile: vo2ctx.percentile,
      fitnessAge: vo2ctx.fitnessAge,
    };
  }

  // Strength standard (#152) — the strongest standing across the core barbell
  // lifts the profile has trained, from the SAME strengthStanding computation the
  // exercise-detail coaching line uses. Hidden without sex or a known bodyweight.
  const bodyweightKg = getLatestBodyMetric(profileId, "weight");
  if (sex && bodyweightKg) {
    const standings = getStrengthByExercise(profileId)
      .map((e) => strengthStanding(e.exercise, e.e1rmKg, sex, bodyweightKg))
      .filter((s): s is NonNullable<typeof s> => s != null);
    const best = bestStanding(standings);
    if (best) inputs.strength = { level: best.level, lift: best.lift };
  }

  // Sleep regularity (#160, SRI).
  const sri = getSleepRegularity(profileId);
  if (sri) {
    inputs.sleep = { sri: sri.sri, trend: sriTrendArrow(profileId) };
  }

  // Biological age (#157/#209, PhenoAge) — adult-gated like its hero card.
  if (!isBioAgeHiddenForAge(age)) {
    const draws = getBioAgeReadings(profileId).draws.filter(
      (d) => d.chronoAge != null
    );
    const latest = draws[draws.length - 1];
    if (latest && latest.chronoAge != null) {
      const delta = bioAgeDelta(latest.bioAge, latest.chronoAge);
      let trend: PillarTrend | null = null;
      if (draws.length >= 2) {
        const prev = draws[draws.length - 2];
        const prevDelta = (prev.bioAge as number) - (prev.chronoAge as number);
        const d = Number((delta.deltaYears - prevDelta).toFixed(1));
        // A shrinking (more negative) gap is the good direction.
        if (d !== 0)
          trend = {
            direction: d < 0 ? "down" : "up",
            label: d < 0 ? "gap narrowing" : "gap widening",
          };
      }
      inputs.bioAge = { delta, trend };
    }
  }

  // % of tracked biomarkers in their optimal range — the curated optimal bands.
  const readings: BiomarkerReading[] = getMedicalRecords(profileId, {
    current: true,
  })
    .filter((r) => LAB_CATEGORIES.has(r.category) && r.canonical_name)
    .map((r) => ({
      value_num: r.value_num,
      unit: r.unit,
      cb: getCanonicalBiomarker(r.canonical_name as string) ?? null,
    }));
  const hitRate = optimalRangeHitRate(readings, sex, age);
  if (hitRate.total > 0) inputs.optimal = hitRate;

  return buildPillars(inputs);
}
