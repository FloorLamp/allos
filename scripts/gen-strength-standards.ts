// Pre-generate the baked bodyweight-band strength-standards dataset
// (lib/datasets/data/strength-standards.json) used to turn an estimated 1RM into
// COACHING CONTEXT ("your squat is at the intermediate standard for your bodyweight")
// on the exercise-detail surfaces and the strength healthspan pillar — issue #152. As
// of issue #860 Track B it is a curated-dataset FRAMEWORK envelope
// (id/citation/identity/entries) consumed via lib/datasets/strength-standards.ts;
// lib/strength-standards.ts is the pure lookup over its entries.
//
// Mirrors the gen-fitness-norms.ts / gen-canonical-biomarkers.ts pattern: the curated
// anchor ratios + allometric formula below are the SOURCE OF TRUTH, HUMAN-REVIEWABLE,
// and the committed JSON is a FIXED POINT of buildStrengthStandards() (guarded by
// lib/__tests__/strength-standards-dataset.test.ts so the generator and the committed
// file can't silently diverge). No API key — the table is DERIVED FROM A DOCUMENTED
// FORMULA, so generation is fully deterministic:
//
//   npm run gen:strength-standards
//
// ── METHODOLOGY & SOURCING (license-clean — no proprietary tables) ──────────────
// The polished commercial charts (Strength Level, Symmetric Strength) are
// proprietary and are NOT used or scraped. Instead every threshold here is
// DERIVED, transparently, from two openly-reusable ingredients:
//
//  1. ANCHOR RATIOS (1RM ÷ bodyweight at a reference bodyweight). These are the
//     project's own already-committed strength multiples in lib/strength.ts
//     (STANDARDS / STANDARDS_FEMALE — "approximate, blended from common strength-
//     standard charts"), reused here so the two models agree at the reference
//     bodyweight, and extended downward with a `beginner` tier below the existing
//     novice entry (an able-but-untrained lifter is roughly two-thirds of a
//     novice standard — a documented rule-of-thumb offset, not a scraped value).
//
//  2. ALLOMETRIC BODYWEIGHT SCALING. Raw bodyweight ratios mislabel lifters at
//     the extremes — a 60 kg lifter benching 1.5× bodyweight is relatively
//     stronger than a 100 kg lifter at the same ratio. Muscular strength scales
//     with bodyweight to roughly the 2/3 power (the cross-sectional-area law;
//     Lietzke MH, "Relation between weight-lifting totals and body weight,"
//     Science 1956;124:486 — the basis of the classic O'Carroll/allometric
//     handicaps and the modern IPF/Wilks-style adjustments). So an ABSOLUTE 1RM
//     threshold scales as (bodyweight / reference_bodyweight)^(2/3), which makes
//     the implied RATIO fall as bodyweight rises — exactly the empirical pattern.
//
// For each lift × sex the generator therefore bakes, at a grid of bodyweight
// bands, the ABSOLUTE 1RM (kg) for each of five ascending levels
// (beginner/novice/intermediate/advanced/elite). The pure lookup
// (lib/strength-standards.ts) linearly INTERPOLATES that threshold vector between
// the two nearest bodyweight bands — the direct analogue of how lib/fitness-norms
// interpolates its norm vector between age bands.
//
// CAVEAT DISCIPLINE (same as the other baked datasets): these are POPULATION
// reference standards for a household tracker — INFORMATIONAL coaching context,
// not measurements, judgments, or medical/coaching advice. Real standards vary by
// training age, leverages, and equipment. Human-review before trusting. NO PHI —
// pure derived aggregate thresholds.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "strength-standards.json"
);

// The five ascending strength levels every lift×sex band carries a threshold for.
export const STRENGTH_LEVELS = [
  "beginner",
  "novice",
  "intermediate",
  "advanced",
  "elite",
] as const;
export type StrengthLevelKey = (typeof STRENGTH_LEVELS)[number];

export interface StandardBand {
  bodyweight: number; // kg
  values: number[]; // absolute 1RM (kg) per STRENGTH_LEVELS position, ascending
}
export interface SexStandards {
  levels: readonly string[];
  bands: StandardBand[];
}
export interface LiftStandards {
  unit: "kg";
  // A bodyweight lift (Pull Up): the "1RM" folds bodyweight + any added load, so
  // the threshold kg is the total system load — a clean bodyweight rep sits near
  // the novice band. Informational to consumers; the math is identical.
  bodyweight: boolean;
  source: string;
  sexes: { male: SexStandards; female: SexStandards };
}

// One framework ENTRY: a lift with its identity `name` (the canonical exercise name —
// must match the lib/lifts.ts keys / lib/strength.ts byte-for-byte) plus its
// unit/bodyweight flag/per-lift `source` and the male/female band tables. The pure
// lookup (lib/strength-standards.ts) rebuilds a name→LiftStandards map from these.
export interface StrengthStandardEntry extends LiftStandards {
  name: string;
}

export type StrengthStandardsDataset = DatasetEnvelope<StrengthStandardEntry>;

// Reference bodyweight-ratio anchors (1RM ÷ bodyweight) at the reference
// bodyweight for each sex, per level. novice/intermediate/advanced/elite reuse
// lib/strength.ts (STANDARDS / STANDARDS_FEMALE) so the models agree at the
// reference bodyweight; `beginner` is the added sub-novice tier.
type LevelRatios = Record<StrengthLevelKey, number>;
interface LiftSpec {
  bodyweight?: boolean;
  male: LevelRatios;
  female: LevelRatios;
}

// r() keeps the anchor blocks terse and readable.
const r = (
  beginner: number,
  novice: number,
  intermediate: number,
  advanced: number,
  elite: number
): LevelRatios => ({ beginner, novice, intermediate, advanced, elite });

// Keys are the canonical exercise names from lib/lifts.ts. "Bench Press" and
// "Overhead Press" are the variant BASE names (the lookup maps a barbell/bare
// variant onto them, exactly like lib/strength.standardFor). Back Squat, Deadlift
// and Pull Up are plain catalog lifts.
// The novice/intermediate/advanced/elite anchors reuse lib/strength.ts's former
// STANDARDS / STANDARDS_FEMALE ratios verbatim; `beginner` is the added sub-novice
// tier (~0.6-0.85× the novice ratio, a documented rule-of-thumb, not a scraped
// value). The first five (squat/bench/OHP/deadlift/pull-up) are the issue's core
// lifts; the last three (front squat / incline bench / chin up) were also covered
// by the retired ratio model, kept here — via the identical allometric method — so
// unifying onto this dataset doesn't drop a lift that used to show a level.
const LIFTS: Record<string, LiftSpec> = {
  "Bench Press": {
    male: r(0.5, 0.75, 1.0, 1.5, 2.0),
    female: r(0.3, 0.5, 0.75, 1.0, 1.5),
  },
  "Overhead Press": {
    male: r(0.3, 0.45, 0.7, 1.0, 1.4),
    female: r(0.2, 0.3, 0.5, 0.75, 1.0),
  },
  "Back Squat": {
    male: r(0.6, 1.0, 1.5, 2.0, 2.75),
    female: r(0.45, 0.75, 1.25, 1.75, 2.25),
  },
  Deadlift: {
    male: r(0.75, 1.25, 1.75, 2.5, 3.0),
    female: r(0.6, 1.0, 1.5, 2.0, 2.5),
  },
  // Pull Up folds bodyweight into the load; ratio < 1 implies assistance, ~1 a
  // clean bodyweight rep, > 1 added weight.
  "Pull Up": {
    bodyweight: true,
    male: r(0.85, 1.0, 1.25, 1.5, 1.9),
    female: r(0.6, 0.8, 1.0, 1.25, 1.6),
  },
  // Previously-covered lifts (retired ratio model) — same allometric derivation.
  "Front Squat": {
    male: r(0.5, 0.85, 1.25, 1.7, 2.3),
    female: r(0.4, 0.65, 1.0, 1.4, 1.85),
  },
  "Incline Bench Press": {
    male: r(0.35, 0.6, 0.85, 1.25, 1.65),
    female: r(0.25, 0.4, 0.6, 0.85, 1.2),
  },
  "Chin Up": {
    bodyweight: true,
    male: r(0.85, 1.0, 1.3, 1.6, 2.0),
    female: r(0.6, 0.8, 1.05, 1.3, 1.65),
  },
};

// Reference bodyweights (kg) the anchor ratios are stated at, per sex — the pivot
// of the allometric scaling. Chosen as typical reference bodyweights used by the
// common strength charts.
const REF_BW = { male: 80, female: 65 } as const;

// Bodyweight-band grids (kg) the absolute thresholds are baked at, per sex. The
// lookup interpolates between these and clamps outside the range.
const BANDS = {
  male: [50, 60, 70, 80, 90, 100, 110, 120, 130, 140],
  female: [40, 50, 60, 70, 80, 90, 100, 110, 120],
} as const;

// Muscular strength scales with bodyweight to ~the 2/3 power (cross-sectional-area
// law; Lietzke 1956). See the header for the full rationale.
const ALLOMETRIC_EXPONENT = 2 / 3;

const round1 = (n: number) => Math.round(n * 10) / 10;

// Absolute 1RM (kg) threshold for one level at one bodyweight: the reference
// absolute (ratio × reference bodyweight) scaled allometrically to this bodyweight.
function thresholdKg(
  ratioAtRef: number,
  refBw: number,
  bodyweight: number
): number {
  const refAbsolute = ratioAtRef * refBw;
  const scale = Math.pow(bodyweight / refBw, ALLOMETRIC_EXPONENT);
  return round1(refAbsolute * scale);
}

function sexStandards(
  ratios: LevelRatios,
  sex: "male" | "female"
): SexStandards {
  const refBw = REF_BW[sex];
  return {
    levels: [...STRENGTH_LEVELS],
    bands: BANDS[sex].map((bodyweight) => ({
      bodyweight,
      values: STRENGTH_LEVELS.map((lvl) =>
        thresholdKg(ratios[lvl], refBw, bodyweight)
      ),
    })),
  };
}

// Pure builder: assemble the framework envelope from the anchor ratios + allometric
// scaling. The committed lib/datasets/data/strength-standards.json is a FIXED POINT of
// this (guarded by the dataset drift test). Entries are emitted in the curated lift
// order for a stable, reviewable diff.
export function buildStrengthStandards(): StrengthStandardsDataset {
  const entries: StrengthStandardEntry[] = Object.entries(LIFTS).map(
    ([name, spec]) => ({
      name,
      unit: "kg",
      bodyweight: spec.bodyweight ?? false,
      source:
        "Derived: lib/strength.ts anchor ratios scaled allometrically by " +
        "bodyweight^(2/3) (Lietzke 1956). See scripts/gen-strength-standards.ts.",
      sexes: {
        male: sexStandards(spec.male, "male"),
        female: sexStandards(spec.female, "female"),
      },
    })
  );
  return {
    $schema: DATASET_SCHEMA,
    id: "strength-standards",
    title: "Bodyweight-band strength standards",
    description:
      "Baked bodyweight-band strength-standards dataset (issue #152) for COACHING " +
      "CONTEXT on estimated 1RM. Thresholds are DERIVED (no proprietary tables): " +
      "lib/strength.ts anchor ratios scaled by bodyweight^(2/3) (Lietzke 1956, the " +
      "cross-sectional-area law). Committed + HUMAN-REVIEWABLE; regenerate with " +
      "`npm run gen:strength-standards`. INFORMATIONAL reference standards, NOT " +
      "measurements or medical/coaching advice.",
    citation: [
      {
        source:
          "Derived thresholds — lib/strength.ts blended strength-standard anchor " +
          "ratios scaled allometrically by bodyweight^(2/3) (Lietzke MH, Science " +
          "1956;124:486, the cross-sectional-area law).",
        note: "No proprietary charts vendored; every threshold is computed from a documented open formula. Each lift additionally carries its own per-lift `source`. INFORMATIONAL, not measurements or coaching advice.",
      },
    ],
    identity: { keys: ["name"] },
    entries,
  };
}

function writeDataset(): void {
  const dataset = buildStrengthStandards();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.entries.length} lift standard tables to ${OUT}`);
  console.log("Review the thresholds for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the drift test imports
// buildStrengthStandards).
if (process.argv[1]?.includes("gen-strength-standards")) {
  writeDataset();
}
