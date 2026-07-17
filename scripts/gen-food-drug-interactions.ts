// Pre-generate the baked FOOD–DRUG interaction dataset
// (lib/datasets/data/food-drug-interactions.json), used to surface per-item food
// guidance on a medication/supplement (issue #154, extends #144). As of issue #860
// Track B it is a curated-dataset FRAMEWORK envelope (id/citation/identity/entries)
// consumed via lib/datasets/food-drug-interactions.ts; lib/food-drug-interactions.ts is
// the DOMAIN matcher over it.
//
// SOURCING / LICENSE
// ------------------
// A CURATED set of well-established, high-severity food–drug pairs, NOT an exhaustive
// database. The facts are drawn from PUBLIC, license-clean references:
//
//   • FDA Structured Product Labeling / DailyMed — the drug-interactions and
//     patient-counseling sections of a drug's official label are a PUBLIC-DOMAIN
//     U.S. Government work (also served by openFDA). Public domain.
//   • NIH MedlinePlus / NLM — public-domain U.S. Government health references.
//   • RxNorm (NLM) — the ingredient RxCUIs below are from RxNorm, a public-domain
//     U.S. Government normalized drug vocabulary. Public domain.
//
// We deliberately DO NOT vendor a copyrighted commercial interaction database
// (Micromedex, Lexicomp, First Databank, Multum). Every pair here is a common,
// textbook interaction any clinical reference states plainly. EVERYTHING IS
// INFORMATIONAL, NEVER PRESCRIPTIVE — the absence of an entry does NOT mean a food is
// safe with a drug.
//
// GENERATION
// ----------
// Mirrors gen-medication-descriptions.ts: the HAND-MAINTAINED source of truth is
// scripts/food-drug-interactions.source.json; the JSON is GENERATED from it and
// COMMITTED, and it is never hand-edited. Edit the source file and re-run:
//
//   npm run gen:food-drug-interactions
//
// The committed lib/datasets/data/food-drug-interactions.json is a FIXED POINT of
// buildFoodDrugInteractionsDataset() (guarded by
// lib/__tests__/food-drug-interactions-dataset.test.ts) so the generator and the file
// can't silently diverge. The envelope is emitted with `JSON.stringify(dataset, null,
// 2)`, which matches Prettier's JSON formatting, so no .prettierignore entry is needed.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";
import type { LifeStage } from "../lib/life-stage";
import rawSource from "./food-drug-interactions.source.json";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "food-drug-interactions.json"
);

const SEVERITIES = ["major", "moderate", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

// One food–drug guidance entry. Identity is the stable slug `key` (the dismissal /
// React key, `food-timing:<itemId>:<key>`). An item resolves to an entry by RxCUI
// (authoritative — any of the item's CUIs against `rxcuis`) or a name/synonym fallback
// (`synonyms`); a single item can match SEVERAL entries (warfarin → vitamin K AND
// alcohol), each a distinct guidance line. The optional age gate (issue #851 item 4)
// hides a rule below the profile's known age (the alcohol rules → adult).
export interface FoodDrugEntry {
  key: string;
  drugLabel: string;
  rxcuis: string[];
  synonyms: string[];
  food: string;
  severity: Severity;
  advice: string;
  mechanism: string;
  source: string;
  minLifeStage?: LifeStage;
  minAge?: number;
}

// The bespoke source shape: the same interaction records, hand-maintained.
interface Source {
  interactions: FoodDrugEntry[];
}

export type FoodDrugInteractionsDataset = DatasetEnvelope<FoodDrugEntry>;

// Pure builder: validate + flatten the hand-maintained source into the framework
// envelope. Entries are emitted in source order (a stable, reviewable diff). The
// validation catches an id/severity/field slip in the source before it ships.
export function buildFoodDrugInteractionsDataset(): FoodDrugInteractionsDataset {
  const src = rawSource as unknown as Source;
  const keys = new Set<string>();
  const entries: FoodDrugEntry[] = src.interactions.map((e) => {
    if (!e.key || !e.key.trim())
      throw new Error("gen-food-drug-interactions: entry with empty key");
    if (keys.has(e.key))
      throw new Error(`gen-food-drug-interactions: duplicate key ${e.key}`);
    keys.add(e.key);
    if (!SEVERITIES.includes(e.severity))
      throw new Error(
        `gen-food-drug-interactions: ${e.key} has bad severity ${e.severity}`
      );
    for (const field of [
      "drugLabel",
      "food",
      "advice",
      "mechanism",
      "source",
    ] as const) {
      if (!e[field] || !e[field].trim())
        throw new Error(
          `gen-food-drug-interactions: ${e.key} missing ${field}`
        );
    }
    if (!Array.isArray(e.rxcuis) || !Array.isArray(e.synonyms))
      throw new Error(
        `gen-food-drug-interactions: ${e.key} rxcuis/synonyms must be arrays`
      );
    if (e.rxcuis.length === 0 && e.synonyms.length === 0)
      throw new Error(
        `gen-food-drug-interactions: ${e.key} has no rxcuis or synonyms to match on`
      );
    const entry: FoodDrugEntry = {
      key: e.key,
      drugLabel: e.drugLabel,
      rxcuis: e.rxcuis,
      synonyms: e.synonyms,
      food: e.food,
      severity: e.severity,
      advice: e.advice,
      mechanism: e.mechanism,
      source: e.source,
    };
    // Preserve the optional age gate only when present (a stable diff — no undefined
    // keys leaking into the JSON).
    if (e.minLifeStage != null) entry.minLifeStage = e.minLifeStage;
    if (e.minAge != null) entry.minAge = e.minAge;
    return entry;
  });

  return {
    $schema: DATASET_SCHEMA,
    id: "food-drug-interactions",
    title: "Food–drug interaction guidance",
    description:
      "Baked per-item food–drug guidance (issue #154, extends #144) — the food note " +
      "shown on a medication/supplement card and dose reminder. CURATED HIGH-VALUE " +
      "SUBSET, not exhaustive; facts from public-domain FDA/DailyMed labeling, NIH " +
      "MedlinePlus/NLM, and RxNorm ingredient concepts (all public domain). " +
      "INFORMATIONAL, never prescriptive — absence of an entry does NOT mean a food is " +
      "safe with a drug. Committed + HUMAN-REVIEWABLE; regenerate with " +
      "`npm run gen:food-drug-interactions`.",
    citation: [
      {
        source:
          "FDA Structured Product Labeling / DailyMed drug-interaction and " +
          "patient-counseling sections; NIH MedlinePlus / NLM; RxNorm (NLM) " +
          "ingredient concepts.",
        url: "https://dailymed.nlm.nih.gov",
        note: "All public-domain / public U.S. references; each rule additionally carries its own per-rule `source`. Curated high-value subset, not exhaustive.",
      },
    ],
    identity: { keys: ["key"] },
    entries,
  };
}

function main() {
  const dataset = buildFoodDrugInteractionsDataset();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} food–drug interaction entries to ${OUT}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
