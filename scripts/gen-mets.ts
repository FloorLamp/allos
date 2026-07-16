// Pre-generate the baked MET dataset (lib/datasets/data/mets.json) used to ESTIMATE
// calories for manually-logged activities (issue #151).
//
// The Compendium of Physical Activities (Ainsworth et al.) is a PUBLIC dataset that
// maps an activity type/intensity to a metabolic-equivalent (MET) value. With a
// bodyweight and a duration, calories are pure arithmetic: kcal = METs × weight(kg)
// × hours. This script writes the curated, PUBLIC MET values below — keyed to the
// existing activities catalog (lib/activities-catalog.ts), with per-activity
// easy/moderate/hard intensity tiers.
//
// As of issue #860 Track B this dataset is the FIRST migrated onto the curated-
// dataset framework (lib/datasets/): the output is a framework ENVELOPE
// (id/citation/identity/entries + dataset-level meta), not the old bespoke
// `{ defaultTier, activities, typeDefaults }` map. The JSON is COMMITTED and
// HUMAN-REVIEWABLE, and the values are INFORMATIONAL (population-average estimates,
// not measurements). Generation needs NO API key — the MET values are well-
// established public constants curated inline, so it is fully deterministic:
//
//   npm run gen:mets
//
// Anti-drift: every CARDIO_ACTIVITIES / SPORTS name in the catalog MUST have an
// entry here (a catalog name with no MET tier falls back to the per-type default,
// which is fine but is pinned by lib/__tests__/mets-dataset.test.ts so a new
// catalog activity that deserves its own tiers isn't silently defaulted). The
// committed mets.json is a FIXED POINT of buildMetsDataset() — the same test guards
// that the generator and the committed file can't desync.

import fs from "node:fs";
import path from "node:path";
import { CARDIO_ACTIVITIES, SPORTS } from "../lib/activities-catalog";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(process.cwd(), "lib", "datasets", "data", "mets.json");

// The three intensity tiers, matching the activity form's INTENSITIES
// (lib/activity-form-model.ts): easy / moderate / hard. An activity logged with no
// intensity is scored at the MODERATE tier (see lib/calorie-estimate.ts).
export type MetTier = "easy" | "moderate" | "hard";
export type MetTiers = Record<MetTier, number>;
export type ActivityType = "strength" | "cardio" | "sport";

// Per-activity MET values by intensity tier, keyed by the EXACT catalog display
// name (lib/activities-catalog.ts). PUBLIC Compendium of Physical Activities values
// (Ainsworth BE et al., 2011 Compendium; https://pacompendium.com), rounded and
// bucketed into easy/moderate/hard from the compendium's per-activity rows. These
// are population-average ESTIMATES, not measurements — human-review before trusting.
const CARDIO_METS: Record<string, MetTiers> = {
  Running: { easy: 6.0, moderate: 9.8, hard: 11.8 },
  Walking: { easy: 2.8, moderate: 3.5, hard: 5.0 },
  Cycling: { easy: 4.0, moderate: 8.0, hard: 10.0 },
  Swimming: { easy: 6.0, moderate: 8.3, hard: 9.8 },
  Rowing: { easy: 4.8, moderate: 7.0, hard: 8.5 },
  Elliptical: { easy: 4.6, moderate: 5.0, hard: 7.0 },
  "Stair Climber": { easy: 4.0, moderate: 8.0, hard: 9.0 },
  "Jump Rope": { easy: 8.8, moderate: 11.8, hard: 12.3 },
  Hiking: { easy: 5.3, moderate: 6.0, hard: 7.8 },
  Rucking: { easy: 6.0, moderate: 7.0, hard: 8.3 },
  Treadmill: { easy: 4.5, moderate: 6.0, hard: 8.5 },
  "Spin Class": { easy: 6.8, moderate: 8.5, hard: 10.0 },
  HIIT: { easy: 6.0, moderate: 8.0, hard: 10.0 },
  "Incline Walk": { easy: 4.5, moderate: 6.0, hard: 8.0 },
  "Trail Run": { easy: 6.5, moderate: 9.0, hard: 10.5 },
  Kayaking: { easy: 3.5, moderate: 5.0, hard: 7.0 },
  Canoeing: { easy: 3.5, moderate: 5.0, hard: 7.0 },
  Paddleboarding: { easy: 4.0, moderate: 6.0, hard: 8.0 },
  Skiing: { easy: 4.3, moderate: 5.3, hard: 8.0 },
  "Cross-Country Skiing": { easy: 6.8, moderate: 9.0, hard: 12.5 },
  Snowshoeing: { easy: 5.3, moderate: 7.5, hard: 10.0 },
  "Ice Skating": { easy: 5.5, moderate: 7.0, hard: 9.0 },
  Skating: { easy: 5.5, moderate: 7.0, hard: 9.0 },
  Rollerblading: { easy: 7.0, moderate: 9.8, hard: 12.5 },
  "Mountain Biking": { easy: 6.8, moderate: 8.5, hard: 10.0 },
  "Stationary Bike": { easy: 4.8, moderate: 7.0, hard: 10.5 },
  "Air Bike": { easy: 5.0, moderate: 7.0, hard: 10.0 },
  SkiErg: { easy: 6.0, moderate: 8.0, hard: 10.0 },
  "Mixed Cardio": { easy: 4.5, moderate: 6.0, hard: 8.0 },
  "Cardio Class": { easy: 4.5, moderate: 6.0, hard: 7.5 },
  Aerobics: { easy: 5.0, moderate: 6.5, hard: 7.3 },
  "Water Aerobics": { easy: 3.5, moderate: 4.5, hard: 5.5 },
  Zumba: { easy: 5.0, moderate: 6.5, hard: 8.0 },
  Bootcamp: { easy: 6.0, moderate: 8.0, hard: 10.0 },
  "Circuit Training": { easy: 5.0, moderate: 7.0, hard: 8.0 },
  CrossFit: { easy: 6.0, moderate: 8.0, hard: 10.0 },
  Calisthenics: { easy: 3.8, moderate: 5.0, hard: 8.0 },
};

const SPORT_METS: Record<string, MetTiers> = {
  Tennis: { easy: 5.0, moderate: 7.3, hard: 8.0 },
  Basketball: { easy: 4.5, moderate: 6.5, hard: 8.0 },
  Soccer: { easy: 7.0, moderate: 8.0, hard: 10.0 },
  Football: { easy: 5.0, moderate: 8.0, hard: 9.0 },
  Baseball: { easy: 4.0, moderate: 5.0, hard: 6.0 },
  Softball: { easy: 4.0, moderate: 5.0, hard: 6.0 },
  Volleyball: { easy: 3.0, moderate: 4.0, hard: 8.0 },
  Badminton: { easy: 4.5, moderate: 5.5, hard: 7.0 },
  "Table Tennis": { easy: 3.5, moderate: 4.0, hard: 5.0 },
  Squash: { easy: 7.0, moderate: 9.0, hard: 12.0 },
  Pickleball: { easy: 4.0, moderate: 5.5, hard: 7.0 },
  Racquetball: { easy: 6.0, moderate: 7.0, hard: 10.0 },
  Golf: { easy: 3.5, moderate: 4.8, hard: 5.3 },
  Hockey: { easy: 6.0, moderate: 8.0, hard: 10.0 },
  Lacrosse: { easy: 5.0, moderate: 7.0, hard: 8.0 },
  Rugby: { easy: 6.3, moderate: 8.3, hard: 10.0 },
  Cricket: { easy: 3.8, moderate: 5.0, hard: 6.0 },
  Handball: { easy: 6.0, moderate: 8.0, hard: 12.0 },
  "Water Polo": { easy: 7.0, moderate: 10.0, hard: 12.0 },
  Boxing: { easy: 6.0, moderate: 9.0, hard: 12.8 },
  Kickboxing: { easy: 6.0, moderate: 8.5, hard: 10.3 },
  "Martial Arts": { easy: 5.3, moderate: 8.0, hard: 10.3 },
  Wrestling: { easy: 5.0, moderate: 6.0, hard: 7.0 },
  "Rock Climbing": { easy: 5.8, moderate: 8.0, hard: 11.0 },
  Bouldering: { easy: 5.0, moderate: 7.0, hard: 9.0 },
  Gymnastics: { easy: 3.8, moderate: 5.0, hard: 6.0 },
  Surfing: { easy: 3.0, moderate: 5.0, hard: 7.0 },
  Snowboarding: { easy: 4.3, moderate: 5.3, hard: 8.0 },
  Skateboarding: { easy: 5.0, moderate: 6.0, hard: 7.0 },
  "Ultimate Frisbee": { easy: 5.0, moderate: 8.0, hard: 9.0 },
  Yoga: { easy: 2.5, moderate: 3.0, hard: 4.0 },
  Pilates: { easy: 2.8, moderate: 3.0, hard: 4.0 },
  Barre: { easy: 2.8, moderate: 3.5, hard: 4.5 },
  "Tai Chi": { easy: 2.5, moderate: 3.0, hard: 4.0 },
  Stretching: { easy: 2.3, moderate: 2.5, hard: 2.8 },
  Dancing: { easy: 3.0, moderate: 5.0, hard: 7.8 },
};

// Fallback MET tiers by activity TYPE, used when an activity name has no per-name
// entry above (a user-coined cardio/sport name, or any STRENGTH component — the
// strength catalog is the open-ended lift vocabulary, so strength always resolves
// here to the compendium's general "resistance training" tiers rather than being
// enumerated lift-by-lift). PUBLIC compendium generals.
const TYPE_DEFAULTS: Record<ActivityType, MetTiers> = {
  // Resistance training: compendium ~3.5 (light) → 6.0 (vigorous).
  strength: { easy: 3.5, moderate: 5.0, hard: 6.0 },
  cardio: { easy: 4.0, moderate: 6.0, hard: 8.0 },
  sport: { easy: 4.5, moderate: 6.5, hard: 8.0 },
};

// One framework entry: an activity display name (the identity key) plus its three
// intensity-tier MET values, flattened onto the entry. The framework matcher keys on
// `name`.
export interface MetEntry extends MetTiers {
  name: string;
}

// Dataset-level metadata that ISN'T per-entry: the default tier for a no-intensity
// activity, and the per-activity-type fallback tiers (an unknown name / any strength
// component resolves here). Carried in the envelope's `meta`.
export interface MetsMeta {
  defaultTier: MetTier;
  typeDefaults: Record<ActivityType, MetTiers>;
}

export type MetsDataset = DatasetEnvelope<MetEntry, MetsMeta>;

// Pure builder: assemble the framework envelope from the curated tables. The
// committed lib/datasets/data/mets.json is a FIXED POINT of this (guarded by the
// dataset test), so the generator and committed file can't silently diverge. Entries
// are emitted in catalog order (cardio then sport) for a stable, reviewable diff.
export function buildMetsDataset(): MetsDataset {
  const entries: MetEntry[] = [];
  for (const name of CARDIO_ACTIVITIES) {
    if (CARDIO_METS[name]) entries.push({ name, ...CARDIO_METS[name] });
  }
  for (const name of SPORTS) {
    if (SPORT_METS[name]) entries.push({ name, ...SPORT_METS[name] });
  }
  return {
    $schema: DATASET_SCHEMA,
    id: "mets",
    title: "Activity MET values for calorie estimation",
    description:
      "Baked MET (metabolic-equivalent) values for ESTIMATING calories on " +
      "manually-logged activities (kcal = METs × weight(kg) × hours), keyed to " +
      "lib/activities-catalog.ts by display name. Committed + HUMAN-REVIEWABLE. " +
      "Regenerate with `npm run gen:mets`. INFORMATIONAL population-average " +
      "estimates, NOT measurements or medical advice.",
    citation: [
      {
        source:
          "Ainsworth BE, Haskell WL, Herrmann SD, et al. 2011 Compendium of " +
          "Physical Activities: a second update of codes and MET values. Med Sci " +
          "Sports Exerc. 2011;43(8):1575-1581.",
        url: "https://pacompendium.com",
        note: "Public MET reference; values rounded and bucketed into easy/moderate/hard tiers.",
      },
    ],
    identity: { keys: ["name"] },
    meta: {
      defaultTier: "moderate",
      typeDefaults: TYPE_DEFAULTS,
    },
    entries,
  };
}

function writeDataset(): void {
  const dataset = buildMetsDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  const named = dataset.entries.length;
  console.log(`Wrote ${named} activity MET entries to ${OUT}`);
  console.log("Review the MET values for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildMetsDataset).
if (process.argv[1]?.includes("gen-mets")) {
  writeDataset();
}
