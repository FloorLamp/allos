// Pre-generate the baked ROUGH population-reference band ladder for the two isometric
// HOLD tests in the guided Fitness check — dead hang and plank (issue #1135).
//
// WHY A SEPARATE, WEAKER STRUCTURE. Dead hang and plank have NO standardized published
// percentile norms (unlike VO2 Max, grip, chair-stand, …). The #834 honesty discipline
// forbids inventing a 1–99 PERCENTILE for a value the literature can't place that
// precisely. But rough figures for these holds DO exist, coarsely and non-standardized —
// so the honest move is a DISCLOSED, COARSE BAND LADDER (weak / fair / good / excellent),
// modeled on scripts/gen-strength-standards.ts's interpolated band ladder (#152), NOT on
// scripts/gen-fitness-norms.ts's percentile curve (#158). The dataset carries an explicit
// `quality: "rough"` flag so every surface renders the "rough guide" disclosure FROM DATA,
// never a hardcoded string, and stays OUT of the percentile engine (lib/fitness-norms) and
// the fitness-age headline by construction.
//
//   npm run gen:fitness-hold-norms
//
// ── METHODOLOGY & SOURCING (no proprietary tables) ──────────────────────────────
// Sex-keyed only — the cited figures don't support age banding, so age banding is
// deliberately omitted (per the issue: "age-banded only if the source data supports it —
// otherwise sex-only"). Every threshold is a curated, HUMAN-REVIEWABLE cutoff drawn from
// widely-repeated coaching/clinical rules of thumb, kept coarse on purpose:
//
//  • PLANK (forearm). Commonly-cited guidance treats ~30 s as a minimum, ~60 s as solid,
//    and ~120 s as a strong ceiling for a general adult; McGill's back-fitness work uses
//    holds in this range as trunk-endurance references. Women's cutoffs are set modestly
//    lower to reflect the typical distribution, not a hard physiological law.
//      Refs: McGill SM, "Low Back Disorders" (trunk flexor-endurance holds); Bianco A
//      et al., "A prospective analysis of the plank exercise," J Sports Med Phys Fitness
//      2015 (plank reliability/normative context); Strand SL et al., J Strength Cond Res
//      2014 (plank-hold reference values by sex).
//
//  • DEAD HANG (two-arm, full grip, to grip failure). Grip endurance rules of thumb:
//    ~30 s a baseline, ~60 s good, ~120 s excellent for a general adult; grip STRENGTH
//    (not hang time) is the mortality-linked measure (Bohannon 2019), so hang-time bands
//    are explicitly a rough proxy, never a validated risk stratifier.
//      Refs: Bohannon RW, "Grip strength: an indispensable biomarker," Clin Interv Aging
//      2019 (motivates grip as a marker — NOT a hang-time norm); widely-repeated
//      strength-coaching hang-time guidance (baseline/good/excellent tiers).
//
// CAVEAT DISCIPLINE (same as every baked dataset): these are ROUGH, UNVALIDATED
// population references for a household tracker — INFORMATIONAL coaching context, not
// measurements, diagnoses, or medical/coaching advice. NO PHI — pure curated cutoffs.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "fitness-hold-norms.json"
);

// The four ascending bands every hold×sex ladder places a value on.
export const HOLD_BANDS = ["weak", "fair", "good", "excellent"] as const;
export type HoldBand = (typeof HOLD_BANDS)[number];

// The quality flag EVERY entry carries — surfaces read this to render the disclosure.
// A single literal so the "rough" contract is one source of truth.
export const HOLD_NORM_QUALITY = "rough" as const;
export type HoldNormQuality = typeof HOLD_NORM_QUALITY;

// One sex's ascending FLOOR ladder (seconds): the minimum hold for each band. `weak`
// always floors at 0 (any measured hold is at least "weak"); the remaining three floors
// are the cutoffs into fair / good / excellent. The pure lookup places a value on the
// highest floor it clears and interpolates a 0–100 position between adjacent floors — the
// direct analogue of lib/strength-standards' placeOnLevels.
export interface HoldSexLadder {
  // Aligned with HOLD_BANDS, ascending. floors[0] === 0.
  floors: number[];
}

// One framework ENTRY: a hold test with its identity `name` (the battery test key —
// "deadhang" / "plank", byte-for-byte) plus its unit, the rough-quality flag, a per-entry
// source, and the male/female floor ladders.
export interface HoldNormEntry {
  name: string;
  unit: "seconds";
  quality: HoldNormQuality;
  source: string;
  bands: readonly HoldBand[];
  sexes: { male: HoldSexLadder; female: HoldSexLadder };
}

export type HoldNormsDataset = DatasetEnvelope<HoldNormEntry>;

// Curated floor ladders (seconds). weak=0, then fair / good / excellent cutoffs. Kept
// deliberately coarse (round 10s/15s/30s steps) — precision the sources don't support.
interface HoldSpec {
  source: string;
  male: [number, number, number, number]; // weak(0), fair, good, excellent
  female: [number, number, number, number];
}

const HOLDS: Record<string, HoldSpec> = {
  plank: {
    source:
      "Rough coaching/clinical rules of thumb: ~30s minimum, ~60s solid, ~120s strong " +
      "(McGill trunk-endurance holds; Bianco 2015; Strand 2014). Coarse and " +
      "non-standardized — a disclosed rough guide, not a validated norm.",
    male: [0, 30, 60, 120],
    female: [0, 20, 45, 90],
  },
  deadhang: {
    source:
      "Rough grip-endurance rules of thumb: ~30s baseline, ~60s good, ~120s excellent. " +
      "Grip STRENGTH (not hang time) is the mortality-linked measure (Bohannon 2019); " +
      "hang-time bands are a disclosed rough proxy, not a risk stratifier.",
    male: [0, 30, 60, 120],
    female: [0, 20, 45, 90],
  },
};

// Curated display order (matches the battery order: dead hang before plank in the adult
// battery, but the dataset order is alphabetical-stable for a reviewable diff).
const ORDER = ["deadhang", "plank"] as const;

export function buildFitnessHoldNorms(): HoldNormsDataset {
  const entries: HoldNormEntry[] = ORDER.map((name) => {
    const spec = HOLDS[name];
    return {
      name,
      unit: "seconds",
      quality: HOLD_NORM_QUALITY,
      source: spec.source,
      bands: [...HOLD_BANDS],
      sexes: {
        male: { floors: [...spec.male] },
        female: { floors: [...spec.female] },
      },
    };
  });
  return {
    $schema: DATASET_SCHEMA,
    id: "fitness-hold-norms",
    title: "Rough isometric-hold reference bands (dead hang, plank)",
    description:
      "Baked ROUGH population-reference band ladders (weak/fair/good/excellent) for the " +
      "dead-hang and plank hold tests (issue #1135). DISCLOSED-ROUGH by design: these " +
      "holds have no standardized percentile norms, so a coarse cited band ladder — NOT " +
      "a fabricated 1–99 percentile — colors the #1132 grid tiles by favorability while " +
      "every surface renders the `quality: rough` disclosure. Sex-keyed only (the cited " +
      "figures don't support age banding). Regenerate with `npm run gen:fitness-hold-norms`.",
    citation: [
      {
        source:
          "Curated rough coaching/clinical rules of thumb for plank and dead-hang holds " +
          "(McGill, Low Back Disorders; Bianco 2015; Strand 2014; Bohannon 2019 for grip " +
          "as a marker). Coarse, non-standardized — a DISCLOSED ROUGH GUIDE.",
        note: "No standardized percentile norms exist for these holds; every threshold is a coarse, human-reviewable cutoff carrying an explicit `quality: rough` flag. INFORMATIONAL, not measurements or medical/coaching advice.",
      },
    ],
    identity: { keys: ["name"] },
    entries,
  };
}

function writeDataset(): void {
  const dataset = buildFitnessHoldNorms();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.entries.length} rough hold-norm ladders to ${OUT}`);
  console.log("Review the coarse cutoffs for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the drift test imports the builder).
if (process.argv[1]?.includes("gen-fitness-hold-norms")) {
  writeDataset();
}
