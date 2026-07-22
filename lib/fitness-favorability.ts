// Pure favorability (0–100, higher = healthier) for the guided Fitness check's `body` and
// `evidence` tiers — the color source for the #1132 grid tiles that are NOT a percentile
// or a strength standard. Higher favorability = greener; lower = redder. DB-free and pure
// so it's unit-tested in lib/__tests__.
//
// HONESTY DISCIPLINE (#834 / #1132): these are DISTANCE-FROM-REFERENCE encodings, never an
// invented percentile. The `body` tier grades by distance OUTSIDE a healthy range (a
// too-low AND a too-high value both redden — symmetric); the `evidence` tier grades by
// signed distance from a CITED threshold (greener further into "good", redder into "risk",
// amber near the line). The reference numbers mirror the canonical biomarker ranges the
// app already ships (Resting Heart Rate / Body Fat Percentage in lib/canonical-biomarkers)
// and the cited single-test scales the evidence-tier tests document — kept here as small,
// self-contained constants so the pure grid VM needs no DB read.

import type { Sex } from "@/lib/types";

// A symmetric healthy band [lo, hi]: inside → fully favorable (100); outside either edge →
// grade down by the distance past that edge, normalized by `spread` (the count of band-
// widths of slack before it reaches 0). One band-width outside ≈ 0.
interface HealthyBand {
  lo: number;
  hi: number;
  spread: number; // multiples of (hi-lo) of distance-outside that map to 0 favorability
}

// Body-fat % healthy bands (a "fitness/healthy" core, reddening either side). Sex-keyed:
// canonical is male-oriented (optimal 10–20%); women carry ~8–10% more essential fat.
// Refs: ACE body-fat categories (fitness/acceptable ranges); lib/canonical-biomarkers
// "Body Fat Percentage" (optimal 10–20, male-oriented). Rough, informational.
const BODY_FAT_BAND: Record<Sex, HealthyBand> = {
  male: { lo: 8, hi: 20, spread: 1.4 },
  female: { lo: 15, hi: 28, spread: 1.4 },
};

// Resting-HR healthy band (bpm). Canonical optimal is 50–65 with a reference ceiling of
// 100; a below-50 resting HR is elite-endurance territory (still fine), so the low edge is
// generous. Ref: lib/canonical-biomarkers "Resting Heart Rate" (optimal 50–65, ref 50–100,
// lower_better). Symmetric grading past the band edges.
const RESTING_HR_BAND: HealthyBand = { lo: 45, hi: 65, spread: 1.8 };

function bandFavorability(value: number, band: HealthyBand): number {
  const width = band.hi - band.lo;
  if (value >= band.lo && value <= band.hi) return 100;
  const outside = value < band.lo ? band.lo - value : value - band.hi;
  const norm = width > 0 ? outside / (width * band.spread) : 1;
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - norm))));
}

// Favorability for a `body`-tier test value. Null when the test isn't a known body test or
// a required input (sex for body fat) is missing — the tile then stays neutral.
export function bodyFavorability(
  testKey: string,
  value: number | null | undefined,
  sex: Sex | null | undefined
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (testKey === "bodyfat") {
    if (!sex) return null;
    return bandFavorability(value, BODY_FAT_BAND[sex]);
  }
  if (testKey === "restinghr") {
    return bandFavorability(value, RESTING_HR_BAND);
  }
  return null;
}

// A cited single-test threshold: `good` at/above (or below, for lowerIsBetter) the "good"
// end, `risk` at the risk end, linear favorability between, clamped outside.
interface EvidenceScale {
  risk: number; // value at ~0 favorability
  good: number; // value at ~100 favorability
}

// Evidence-tier cited scales (see each test's `interpretation` + `citation` in the
// battery). All three are higher-is-better on their own scale:
//   • hrr  — 1-min heart-rate recovery: ≤12 bpm predicts higher mortality (Cole 1999);
//            ~30 bpm is a robustly healthy recovery.
//   • srt  — sitting-rising test: <8/10 linked to higher mortality (Araújo 2014); 10 best.
//   • fourstage — CDC STEADI: not holding the full tandem (stage 3) 10 s = fall risk; 4/4
//            is best. Risk floor at stage 2 (failed tandem).
const EVIDENCE_SCALES: Record<string, EvidenceScale> = {
  hrr: { risk: 8, good: 30 },
  srt: { risk: 4, good: 10 },
  fourstage: { risk: 2, good: 4 },
};

// Favorability for an `evidence`-tier test value. Null when the test has no cited scale.
export function evidenceFavorability(
  testKey: string,
  value: number | null | undefined
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const s = EVIDENCE_SCALES[testKey];
  if (!s) return null;
  const span = s.good - s.risk;
  if (span === 0) return value >= s.good ? 100 : 0;
  const frac = (value - s.risk) / span;
  return Math.round(Math.max(0, Math.min(100, 100 * frac)));
}
