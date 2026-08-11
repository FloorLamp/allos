// Pre-generate the baked educational medication-descriptions dataset
// (lib/datasets/data/medication-descriptions.json) — a neutral "what it is / drug
// class / what it's commonly used for" entry for a broad set of common medications,
// plus the label-standard `typical` conventions the med form's selection-prefill
// suggests (#846). Consumed by lib/medication-info.ts (the med cards, the name/brand
// comboboxes, the record matcher).
//
// As of issue #860 Track B (wave 2) this dataset is migrated onto the curated-dataset
// framework (lib/datasets/): the output is a framework ENVELOPE
// (id/citation/identity/entries) built by buildMedicationDescriptionsDataset() below,
// and the committed JSON is a FIXED POINT of that builder — guarded by
// lib/__tests__/medication-descriptions-dataset.test.ts so the generator and the file
// can't silently diverge. Before this migration it was the ONE hand-edited dataset
// with no generator and no drift test; this adds both.
//
// SOURCE of truth: scripts/medication-descriptions.source.json — the hand-editable
// bespoke `{ medications: { <key>: {generic, brand_names?, drug_class?, description,
// typical?} }, aliases: { <alias>: <key> } }` map. Edit THAT file, then regenerate:
//
//   npm run gen:medication-descriptions
//
// The generator flattens it into entries[]: each entry carries the same fields plus its
// stable `key`, the `synonyms` that resolve to it (from the alias map), and a computed
// `match_keys` array (generic + brands + synonyms) that the framework's MULTI-VALUE
// matcher (multiValueStrategy) indexes on, so one entry is found under any of its
// names. Combination products (issue #881) additionally carry `ingredients` — the
// catalog generic keys of their active components — so a combo's brands (Vicodin/Norco)
// resolve to the combo AND the acetaminophen it hides is knowable (#798/#279). Content
// is INFORMATIONAL, NOT MEDICAL ADVICE (no dosing, no diagnosis).

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";
import type { FoodTiming } from "../lib/types";
import type { TimeBucket } from "../lib/supplement-schedule";
import rawSource from "./medication-descriptions.source.json";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "medication-descriptions.json"
);

// A curated, CITED "typical use" convention (issue #846) — the label-standard default
// the selection-prefill resolver suggests. See lib/medication-info.ts for the full
// field semantics; the types are duplicated here (a scripts→lib type import would be a
// dependency cycle: lib/medication-info consumes THIS dataset).
export interface MedicationTypical {
  asNeeded?: boolean;
  foodTiming?: FoodTiming;
  timeOfDay?: TimeBucket;
  source: string;
}

// The source's per-medication record (bespoke shape).
interface SourceMedication {
  generic: string;
  brand_names?: string[];
  drug_class?: string;
  description: string;
  typical?: MedicationTypical;
  // Combination-product tier (issue #881): the catalog generic KEYS of this product's
  // active ingredients that are themselves catalog entries (e.g. hydrocodone-
  // acetaminophen → ["hydrocodone", "acetaminophen"]). Present ONLY on combo entries
  // whose components each resolve to a catalog entry; a partial/uncataloged component
  // list is omitted (the #846 absent-means-no-claim discipline). Feeds the acetaminophen-
  // daily-max stretch (#798) and the ingredient-level interaction path (#279); every
  // listed key is pinned to resolve by the dataset test.
  ingredients?: string[];
}

interface Source {
  medications: Record<string, SourceMedication>;
  aliases: Record<string, string>;
}

// One framework entry: a medication with its educational content, its stable key, the
// synonyms (alternate spellings / salt forms) that resolve to it, and the union
// `match_keys` the multi-value matcher indexes on (raw display strings — the matcher
// folds them at index/query time via normalizeMedName). `key` is the NORMALIZED generic
// name and the stable identity; renames are display-only.
export interface MedDescriptionEntry {
  key: string;
  generic: string;
  brand_names?: string[];
  synonyms?: string[];
  drug_class?: string;
  description: string;
  typical?: MedicationTypical;
  // Combination-product ingredient generic keys (#881), passed through from the source.
  // Present only on combo entries whose components are themselves catalog entries.
  ingredients?: string[];
  match_keys: string[];
}

export type MedDescriptionsDataset = DatasetEnvelope<MedDescriptionEntry>;

// De-duplicate a list of raw name strings by their lowercased form, preserving the
// FIRST raw occurrence (so "Acetaminophen" beats a later "acetaminophen"). Only a
// coarse fold for a stable, non-redundant match_keys list — the real query-time
// normalization (strength/form stripping) lives in normalizeMedName.
function dedupNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = (n ?? "").trim();
    if (!t) continue;
    const f = t.toLowerCase();
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(t);
  }
  return out;
}

// Pure builder: flatten the bespoke source into the framework envelope. Entries are
// emitted in the source's medication insertion order for a stable, reviewable diff.
export function buildMedicationDescriptionsDataset(): MedDescriptionsDataset {
  const src = rawSource as unknown as Source;
  const entries: MedDescriptionEntry[] = [];

  for (const [key, info] of Object.entries(src.medications)) {
    // The explicit aliases (alternate spellings, abbreviations, salt forms) that point
    // at this generic key, in alias-map order.
    const synonyms = Object.entries(src.aliases)
      .filter(([, target]) => target === key)
      .map(([alias]) => alias);

    const brand_names = info.brand_names ?? [];
    const match_keys = dedupNames([
      info.generic,
      key,
      ...brand_names,
      ...synonyms,
    ]);

    const entry: MedDescriptionEntry = {
      key,
      generic: info.generic,
      ...(brand_names.length ? { brand_names } : {}),
      ...(synonyms.length ? { synonyms } : {}),
      ...(info.drug_class ? { drug_class: info.drug_class } : {}),
      description: info.description,
      ...(info.typical ? { typical: info.typical } : {}),
      ...(info.ingredients && info.ingredients.length
        ? { ingredients: info.ingredients }
        : {}),
      match_keys,
    };
    entries.push(entry);
  }

  return {
    $schema: DATASET_SCHEMA,
    id: "medication-descriptions",
    title: "Educational medication descriptions",
    description:
      "Baked, human-reviewable educational descriptions for common medications — a " +
      "neutral 'what it is / drug class / commonly used for' entry keyed by generic " +
      "name, with brand names and alternate spellings as lookup aliases (the " +
      "framework's multi-value matcher). Some entries carry a CITED `typical` block " +
      "(label-standard asNeeded/foodTiming/timeOfDay conventions, #846) the med " +
      "form's selection-prefill suggests. INFORMATIONAL, NOT MEDICAL ADVICE — no " +
      "dosing guidance, no diagnosis, no personal recommendations; unmatched " +
      "medications simply show no description. Regenerate with " +
      "`npm run gen:medication-descriptions`.",
    citation: [
      {
        source:
          "U.S. National Library of Medicine — MedlinePlus Drug Information and " +
          "DailyMed FDA drug labels (public).",
        url: "https://medlineplus.gov/druginformation.html",
        note: "Neutral educational drug summaries and class/use information, curated and simplified for personal tracking; per-entry `typical` blocks cite their own OTC/prescribing-label source.",
      },
    ],
    identity: { keys: ["match_keys"] },
    entries,
  };
}

function writeDataset(): void {
  const dataset = buildMedicationDescriptionsDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.entries.length} medication entries to ${OUT}`);
  console.log("Review the descriptions for neutrality before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildMedicationDescriptionsDataset).
if (process.argv[1]?.includes("gen-medication-descriptions")) {
  writeDataset();
}
