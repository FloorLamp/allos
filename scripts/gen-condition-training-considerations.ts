// Pre-generate the baked CONDITION → TRAINING-CONSIDERATION dataset
// (lib/datasets/data/condition-training-considerations.json), used to surface a calm,
// coaching-tier training CONSIDERATION NOTE when a mapped medical condition is active
// (issue #666). It is a curated-dataset FRAMEWORK envelope (id/citation/identity/entries)
// consumed via lib/datasets/condition-training-considerations.ts; the DOMAIN matcher
// (lib/condition-training-considerations.ts) resolves a live condition to entries by
// normalized name/synonym (and an optional ICD-10 code-prefix hint).
//
// SOURCING / LICENSE
// ------------------
// A CURATED set of well-established condition→training considerations, NOT medical advice
// and NOT exhaustive. The facts are drawn from PUBLIC references: ACOG physical-activity
// guidance (pregnancy), NIH NIAMS (osteoporosis), NHLBI/CDC (hypertension, aortic
// aneurysm), and the U.S. HHS Physical Activity Guidelines for Americans. Exercise is
// almost always beneficial for chronic conditions — every entry is a CONSIDERATION, never
// a prohibition, and the recommendation itself is never gated or re-ranked by a condition
// (medical judgment stays with the clinician, #666's taxonomy). EVERYTHING IS
// INFORMATIONAL, NEVER PRESCRIPTIVE — the absence of an entry does NOT mean training is
// unrestricted.
//
// GENERATION
// ----------
// Mirrors gen-food-drug-interactions.ts: the HAND-MAINTAINED source of truth is
// scripts/condition-training-considerations.source.json; the JSON is GENERATED from it and
// COMMITTED, and it is never hand-edited. Edit the source file and re-run:
//
//   npm run gen:condition-training-considerations
//
// The committed lib/datasets/data/condition-training-considerations.json is a FIXED POINT
// of buildConditionTrainingConsiderationsDataset() (guarded by
// lib/__tests__/condition-training-considerations-dataset.test.ts) so the generator and the
// file can't silently diverge. The envelope is emitted with `JSON.stringify(dataset, null,
// 2)`, which matches Prettier's JSON formatting, so no .prettierignore entry is needed.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";
import rawSource from "./condition-training-considerations.source.json";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "condition-training-considerations.json"
);

// One condition→training-consideration entry. Identity is the stable slug `key`. A live
// condition resolves to an entry by a normalized name/synonym match (authoritative) or an
// ICD-10 code-prefix hint (`codePrefixes`); a single condition matches at most one entry.
// The `note` is the calm coaching-tier line surfaced on the next-workout card / live
// header — a consideration, never a prohibition.
export interface ConditionConsiderationEntry {
  key: string;
  conditionLabel: string;
  synonyms: string[];
  codePrefixes: string[];
  note: string;
  source: string;
}

// The bespoke source shape: the same records, hand-maintained.
interface Source {
  considerations: ConditionConsiderationEntry[];
}

export type ConditionTrainingConsiderationsDataset =
  DatasetEnvelope<ConditionConsiderationEntry>;

// Pure builder: validate + flatten the hand-maintained source into the framework
// envelope. Entries are emitted in source order (a stable, reviewable diff). The
// validation catches a key/field slip in the source before it ships.
export function buildConditionTrainingConsiderationsDataset(): ConditionTrainingConsiderationsDataset {
  const src = rawSource as unknown as Source;
  const keys = new Set<string>();
  const entries: ConditionConsiderationEntry[] = src.considerations.map((e) => {
    if (!e.key || !e.key.trim())
      throw new Error(
        "gen-condition-training-considerations: entry with empty key"
      );
    if (keys.has(e.key))
      throw new Error(
        `gen-condition-training-considerations: duplicate key ${e.key}`
      );
    keys.add(e.key);
    for (const field of ["conditionLabel", "note", "source"] as const) {
      if (!e[field] || !e[field].trim())
        throw new Error(
          `gen-condition-training-considerations: ${e.key} missing ${field}`
        );
    }
    if (!Array.isArray(e.synonyms) || !Array.isArray(e.codePrefixes))
      throw new Error(
        `gen-condition-training-considerations: ${e.key} synonyms/codePrefixes must be arrays`
      );
    if (e.synonyms.length === 0 && e.codePrefixes.length === 0)
      throw new Error(
        `gen-condition-training-considerations: ${e.key} has no synonyms or codePrefixes to match on`
      );
    return {
      key: e.key,
      conditionLabel: e.conditionLabel,
      synonyms: e.synonyms,
      codePrefixes: e.codePrefixes,
      note: e.note,
      source: e.source,
    };
  });

  return {
    $schema: DATASET_SCHEMA,
    id: "condition-training-considerations",
    title: "Condition → training considerations",
    description:
      "Baked condition→training CONSIDERATION notes (issue #666) — the calm, " +
      "coaching-tier note shown on the next-workout suggestion when a mapped medical " +
      "condition is active. CURATED HIGH-VALUE SUBSET, not exhaustive; facts from " +
      "public ACOG/NIH/NHLBI/CDC and U.S. HHS physical-activity guidance. INFORMATIONAL, " +
      "never prescriptive — a consideration, NEVER a prohibition; the recommendation is " +
      "never gated or re-ranked by a condition (medical judgment stays with the " +
      "clinician). Committed + HUMAN-REVIEWABLE; regenerate with " +
      "`npm run gen:condition-training-considerations`.",
    citation: [
      {
        source:
          "ACOG Committee Opinion 804 (pregnancy); NIH NIAMS (osteoporosis); " +
          "NHLBI / CDC (hypertension, aortic aneurysm); U.S. HHS Physical Activity " +
          "Guidelines for Americans, 2nd ed.; NIH MedlinePlus.",
        url: "https://health.gov/paguidelines",
        note: "All public U.S. references; each entry additionally carries its own per-entry `source`. Curated high-value subset, not exhaustive. Consideration notes only — never prescriptive.",
      },
    ],
    identity: { keys: ["key"] },
    entries,
  };
}

function main() {
  const dataset = buildConditionTrainingConsiderationsDataset();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} condition-training-consideration entries to ${OUT}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
