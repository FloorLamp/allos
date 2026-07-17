// Pre-generate the baked age/sex fitness-norm dataset
// (lib/datasets/data/fitness-norms.json) used to turn a raw fitness measurement into
// PERCENTILE CONTEXT ("82nd percentile for your age") and the inverse FITNESS AGE (the
// age whose 50th-percentile value matches the measurement) — issue #158. As of issue
// #860 Track B it is a curated-dataset FRAMEWORK envelope (id/citation/identity/entries)
// consumed via lib/datasets/fitness-norms.ts; lib/fitness-norms.ts is the pure lookup
// over its entries.
//
// Four markers, each an independent, well-published longevity / frailty predictor:
//   • VO2 Max                 (mL/kg/min) — cardiorespiratory fitness
//   • Grip Strength           (kg)        — whole-body strength / mortality proxy
//   • 30-Second Chair Stand   (reps)      — lower-body strength / frailty
//   • Single-Leg Balance      (seconds)   — postural control / fall risk
//
// Mirrors the gen-canonical-biomarkers.ts / gen-mets.ts / gen-growth-charts.ts
// pattern: the curated PUBLIC normative tables below are the SOURCE OF TRUTH,
// HUMAN-REVIEWABLE, and the committed JSON is a FIXED POINT of buildFitnessNorms()
// (guarded by lib/__tests__/fitness-norms-dataset.test.ts so the generator and the
// committed file can't silently diverge). No API key — the values are curated PUBLIC
// normative tables, so generation is fully deterministic:
//
//   npm run gen:fitness-norms
//
// ── SOURCING (license-clean, published literature only) ─────────────────────────
// VO2 Max — the FRIEND registry (Fitness Registry and the Importance of Exercise
//   National Database). Kaminsky LA, Arena R, Myers J. "Reference Standards for
//   Cardiorespiratory Fitness Measured With Cardiopulmonary Exercise Testing: Data
//   From the FRIEND Registry." Mayo Clin Proc. 2015;90(11):1515-1523. Sex- and
//   decade-specific VO2max percentiles (treadmill), reproduced in ACSM's Guidelines
//   for Exercise Testing and Prescription. Values below are rounded from the
//   published percentile tables.
// Grip Strength — Dodds RM, Syddall HE, Cooper R, et al. "Grip Strength across the
//   Life Course: Normative Data from Twelve British Studies." PLoS ONE 2014;
//   9(12):e113637 (open access, CC-BY). Maximum grip (kg) centile curves by age/sex;
//   values below are read off the published centile smoothers at band midpoints.
// 30-Second Chair Stand — Rikli RE, Jones CJ. Senior Fitness Test Manual (2nd ed.,
//   2013) normative "normal range" tables (the middle-50%, i.e. 25th-75th centile)
//   for community-residing older adults age 60-94, 5-year bands. The 50th centile is
//   the band midpoint. Covers OLDER ADULTS only (60+) — the population where the test
//   is validated and clinically used.
// Single-Leg Balance — Springer BA, Marin R, Cyhan T, Roberts H, Gill NW.
//   "Normative Values for the Unipedal Stance Test with Eyes Open and Closed."
//   J Geriatr Phys Ther. 2007;30(1):8-15. Eyes-OPEN unipedal stance times (seconds),
//   test ceiling 45 s. Springer found no meaningful sex difference eyes-open, so the
//   male/female tables are intentionally identical (documented). Percentiles below
//   are approximated from the published means/SDs by decade.
//
// CAVEAT DISCIPLINE (same as the other baked datasets): these are POPULATION
// reference standards, ROUNDED/approximated from the cited tables for a household
// tracker — INFORMATIONAL context, not measurements, diagnoses, or medical advice.
// Different labs/protocols (e.g. cycle vs treadmill VO2, left vs summed grip) shift
// the numbers. Human-review before trusting. NO PHI — pure published aggregate norms.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "fitness-norms.json"
);

// One age band: the norm values at percentile positions `percentiles[i]`, anchored
// at a representative `age` (a decade band's midpoint). The lookup interpolates the
// value vector linearly BETWEEN band ages, and clamps at the first/last band.
export interface NormBand {
  age: number;
  values: number[];
}
export interface SexNorms {
  percentiles: number[];
  bands: NormBand[];
}
export type Direction = "higher_better";
export interface MarkerNorms {
  unit: string;
  direction: Direction;
  source: string;
  sexes: { male: SexNorms; female: SexNorms };
}

// One framework ENTRY: a marker with its identity `name` (the canonical biomarker name
// — must match the canonical_biomarkers rows / vitals-input names byte-for-byte) plus
// its unit/direction/per-marker `source` citation and the male/female band tables. The
// pure lookup (lib/fitness-norms.ts) rebuilds a name→MarkerNorms map from these entries.
export interface FitnessNormEntry extends MarkerNorms {
  name: string;
}

export type FitnessNormsDataset = DatasetEnvelope<FitnessNormEntry>;

// ── VO2 Max (mL/kg/min) — FRIEND registry, treadmill ────────────────────────────
// Percentiles 10..90 by ten, at decade midpoints 25/35/45/55/65/75.
const VO2_PCTS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
const VO2_MALE: NormBand[] = [
  { age: 25, values: [33.0, 36.7, 39.5, 41.9, 43.9, 45.7, 48.3, 51.1, 55.2] },
  { age: 35, values: [31.5, 34.5, 36.7, 39.0, 42.4, 44.6, 46.8, 48.9, 52.5] },
  { age: 45, values: [30.2, 32.3, 34.6, 36.3, 38.4, 40.6, 42.4, 45.4, 49.2] },
  { age: 55, values: [26.8, 29.4, 31.1, 33.2, 35.2, 36.7, 39.1, 41.0, 45.0] },
  { age: 65, values: [24.5, 26.6, 28.5, 30.0, 31.4, 33.4, 35.2, 38.1, 41.0] },
  { age: 75, values: [21.2, 23.1, 24.6, 26.0, 27.2, 29.1, 30.9, 32.9, 36.5] },
];
const VO2_FEMALE: NormBand[] = [
  { age: 25, values: [28.4, 31.6, 33.8, 35.7, 37.6, 39.8, 41.7, 44.7, 49.6] },
  { age: 35, values: [26.4, 28.5, 30.4, 32.0, 34.0, 36.1, 38.4, 40.5, 44.6] },
  { age: 45, values: [23.9, 25.7, 27.3, 29.1, 30.9, 32.6, 34.3, 36.8, 40.5] },
  { age: 55, values: [21.0, 22.7, 24.1, 25.5, 27.0, 28.6, 30.4, 32.9, 36.4] },
  { age: 65, values: [18.7, 20.4, 21.6, 22.9, 24.2, 25.7, 27.4, 29.4, 32.5] },
  { age: 75, values: [16.5, 17.9, 18.9, 20.0, 21.2, 22.6, 24.0, 25.9, 28.7] },
];

// ── Grip Strength (kg) — Dodds 2014 British centiles, maximum grip ──────────────
// Percentiles 10/25/50/75/90 at midpoints 25..85.
const GRIP_PCTS = [10, 25, 50, 75, 90];
const GRIP_MALE: NormBand[] = [
  { age: 25, values: [40, 45, 51, 56, 61] },
  { age: 35, values: [40, 45, 50, 56, 61] },
  { age: 45, values: [37, 43, 48, 54, 59] },
  { age: 55, values: [33, 39, 44, 50, 55] },
  { age: 65, values: [28, 33, 39, 45, 50] },
  { age: 75, values: [22, 27, 32, 38, 43] },
  { age: 85, values: [16, 20, 25, 30, 35] },
];
const GRIP_FEMALE: NormBand[] = [
  { age: 25, values: [23, 27, 31, 35, 39] },
  { age: 35, values: [23, 27, 31, 35, 39] },
  { age: 45, values: [22, 26, 30, 34, 38] },
  { age: 55, values: [19, 23, 27, 31, 35] },
  { age: 65, values: [16, 20, 24, 28, 32] },
  { age: 75, values: [12, 16, 20, 24, 28] },
  { age: 85, values: [8, 11, 15, 19, 23] },
];

// ── 30-Second Chair Stand (reps) — Rikli & Jones, older adults 60+ ──────────────
// Percentiles 25/50/75 (the published "normal range" bounds + midpoint) at 5-year
// band midpoints 62..92.
const CHAIR_PCTS = [25, 50, 75];
const CHAIR_MALE: NormBand[] = [
  { age: 62, values: [14, 16.5, 19] },
  { age: 67, values: [12, 15, 18] },
  { age: 72, values: [12, 14.5, 17] },
  { age: 77, values: [11, 14, 17] },
  { age: 82, values: [10, 12.5, 15] },
  { age: 87, values: [8, 11, 14] },
  { age: 92, values: [7, 9.5, 12] },
];
const CHAIR_FEMALE: NormBand[] = [
  { age: 62, values: [12, 14.5, 17] },
  { age: 67, values: [11, 13.5, 16] },
  { age: 72, values: [10, 12.5, 15] },
  { age: 77, values: [10, 12.5, 15] },
  { age: 82, values: [9, 11.5, 14] },
  { age: 87, values: [8, 10.5, 13] },
  { age: 92, values: [4, 7.5, 11] },
];

// ── Single-Leg Balance (seconds, eyes open) — Springer 2007 ─────────────────────
// Percentiles 25/50/75 at decade midpoints; 45 s test ceiling. Sex-neutral eyes
// open (Springer found no meaningful eyes-open sex difference), so male == female.
const BALANCE_PCTS = [25, 50, 75];
const BALANCE_BANDS: NormBand[] = [
  { age: 25, values: [40, 44, 45] },
  { age: 35, values: [40, 44, 45] },
  { age: 45, values: [35, 42, 45] },
  { age: 55, values: [28, 37, 44] },
  { age: 65, values: [18, 27, 38] },
  { age: 75, values: [8, 15, 28] },
  { age: 85, values: [3, 6, 12] },
];

// Pure builder: assemble the framework envelope from the curated tables. The committed
// lib/datasets/data/fitness-norms.json is a FIXED POINT of this (guarded by the dataset
// test). Entries are emitted in the curated marker order for a stable, reviewable diff.
export function buildFitnessNorms(): FitnessNormsDataset {
  const entries: FitnessNormEntry[] = [
    {
      name: "VO2 Max",
      unit: "mL/kg/min",
      direction: "higher_better",
      source:
        "FRIEND registry (Kaminsky et al., Mayo Clin Proc 2015), treadmill VO2max percentiles.",
      sexes: {
        male: { percentiles: VO2_PCTS, bands: VO2_MALE },
        female: { percentiles: VO2_PCTS, bands: VO2_FEMALE },
      },
    },
    {
      name: "Grip Strength",
      unit: "kg",
      direction: "higher_better",
      source:
        "Dodds et al., PLoS ONE 2014 (twelve British studies) — maximum grip centiles.",
      sexes: {
        male: { percentiles: GRIP_PCTS, bands: GRIP_MALE },
        female: { percentiles: GRIP_PCTS, bands: GRIP_FEMALE },
      },
    },
    {
      name: "30-Second Chair Stand",
      unit: "reps",
      direction: "higher_better",
      source:
        "Rikli & Jones Senior Fitness Test norms (older adults 60-94; normal-range = 25th-75th centile).",
      sexes: {
        male: { percentiles: CHAIR_PCTS, bands: CHAIR_MALE },
        female: { percentiles: CHAIR_PCTS, bands: CHAIR_FEMALE },
      },
    },
    {
      name: "Single-Leg Balance",
      unit: "seconds",
      direction: "higher_better",
      source:
        "Springer et al., J Geriatr Phys Ther 2007 — unipedal stance, eyes open (45 s ceiling; sex-neutral).",
      sexes: {
        male: { percentiles: BALANCE_PCTS, bands: BALANCE_BANDS },
        female: { percentiles: BALANCE_PCTS, bands: BALANCE_BANDS },
      },
    },
  ];

  return {
    $schema: DATASET_SCHEMA,
    id: "fitness-norms",
    title: "Age/sex fitness reference norms",
    description:
      "Baked age/sex fitness-norm dataset (issue #158) for PERCENTILE context and " +
      "FITNESS AGE on VO2 Max, grip strength, 30-second chair stand, and single-leg " +
      "balance. Published aggregate norms (FRIEND registry; Dodds 2014; Rikli & Jones; " +
      "Springer 2007) — see the per-marker `source` and scripts/gen-fitness-norms.ts " +
      "for citations. Committed + HUMAN-REVIEWABLE; regenerate with " +
      "`npm run gen:fitness-norms`. INFORMATIONAL population reference standards, NOT " +
      "measurements or medical advice.",
    citation: [
      {
        source:
          "VO2 Max — FRIEND registry (Kaminsky et al., Mayo Clin Proc 2015); Grip " +
          "Strength — Dodds et al., PLoS ONE 2014; 30-Second Chair Stand — Rikli & " +
          "Jones Senior Fitness Test norms; Single-Leg Balance — Springer et al., " +
          "J Geriatr Phys Ther 2007.",
        note: "Published aggregate reference standards, rounded from the cited tables; each marker additionally carries its own per-marker `source`. INFORMATIONAL, not measurements or medical advice.",
      },
    ],
    identity: { keys: ["name"] },
    entries,
  };
}

function writeDataset(): void {
  const dataset = buildFitnessNorms();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.entries.length} fitness-norm markers to ${OUT}`);
  console.log(
    "Review the norm values against the cited tables before committing."
  );
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildFitnessNorms).
if (process.argv[1]?.includes("gen-fitness-norms")) {
  writeDataset();
}
