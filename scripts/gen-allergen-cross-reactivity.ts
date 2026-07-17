// Pre-generate the baked ALLERGEN CROSS-REACTIVITY dataset
// (lib/datasets/data/allergen-cross-reactivity.json), used to surface informational
// cross-reaction notes and to back the #691 allergy safety belt (issue #153). As of
// issue #860 Track B it is a curated-dataset FRAMEWORK envelope
// (id/citation/identity/entries) consumed via lib/datasets/allergen-cross-reactivity.ts;
// lib/allergen-cross-reactivity.ts is the DOMAIN matcher over its entries.
//
// SOURCING / LICENSE
// ------------------
// Well-established, clinically static cross-reactivity families (birch-OAS, latex-fruit,
// crustacean tropomyosin, finned-fish parvalbumin, mammalian-milk caseins, …). Each
// family carries a peer-reviewed literature CITATION. This is GENERIC clinical reference
// data — not patient data, not medical advice — from the published allergy literature;
// no copyrighted commercial database is vendored.
//
// GENERATION
// ----------
// Mirrors gen-medication-descriptions.ts / gen-food-drug-interactions.ts: the
// HAND-MAINTAINED source of truth is scripts/allergen-cross-reactivity.source.json; the
// JSON is GENERATED from it and COMMITTED, and it is never hand-edited. Edit the source
// file and re-run:
//
//   npm run gen:allergen-cross-reactivity
//
// The committed lib/datasets/data/allergen-cross-reactivity.json is a FIXED POINT of
// buildAllergenCrossReactivityDataset() (guarded by
// lib/__tests__/allergen-cross-reactivity-dataset.test.ts) so the generator and the file
// can't silently diverge. The envelope is emitted with `JSON.stringify(dataset, null,
// 2)`, which matches Prettier's JSON formatting, so no .prettierignore entry is needed.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";
import rawSource from "./allergen-cross-reactivity.source.json";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "allergen-cross-reactivity.json"
);

// One cross-reactivity family — the framework identity is the stable slug `id`. `members`
// are the allergens that commonly cross-react (lowercase, for natural sentence
// rendering); `aliases` maps a member to alternate spellings/synonyms the matcher also
// recognizes; `label` carries the clinically-noted direction where it matters; `citation`
// is the per-family literature reference.
export interface CrossReactivityFamily {
  id: string;
  name: string;
  label: string;
  citation: string;
  members: string[];
  aliases?: Record<string, string[]>;
}

// The bespoke source shape: the hand-maintained families.
interface Source {
  families: CrossReactivityFamily[];
}

export type AllergenCrossReactivityDataset =
  DatasetEnvelope<CrossReactivityFamily>;

// Pure builder: validate + carry the hand-maintained families into the framework
// envelope. Entries are emitted in source order (a stable, reviewable diff). Validation
// catches a duplicate id, an under-populated family, or a missing label/citation before
// it ships — this dataset is SAFETY-critical (it backs the #691 allergy belt).
export function buildAllergenCrossReactivityDataset(): AllergenCrossReactivityDataset {
  const src = rawSource as unknown as Source;
  const ids = new Set<string>();
  const entries: CrossReactivityFamily[] = src.families.map((f) => {
    if (!f.id || !f.id.trim())
      throw new Error("gen-allergen-cross-reactivity: family with empty id");
    if (ids.has(f.id))
      throw new Error(
        `gen-allergen-cross-reactivity: duplicate family id ${f.id}`
      );
    ids.add(f.id);
    if (!f.name || !f.name.trim())
      throw new Error(`gen-allergen-cross-reactivity: ${f.id} missing name`);
    if (!f.label || !f.label.trim())
      throw new Error(`gen-allergen-cross-reactivity: ${f.id} missing label`);
    if (!f.citation || !f.citation.trim())
      throw new Error(
        `gen-allergen-cross-reactivity: ${f.id} missing citation`
      );
    if (!Array.isArray(f.members) || f.members.length < 2)
      throw new Error(
        `gen-allergen-cross-reactivity: ${f.id} needs at least 2 members`
      );
    const entry: CrossReactivityFamily = {
      id: f.id,
      name: f.name,
      label: f.label,
      citation: f.citation,
      members: f.members,
    };
    // Preserve the optional aliases map only when present (a stable diff — no undefined
    // keys leaking into the JSON).
    if (f.aliases != null) entry.aliases = f.aliases;
    return entry;
  });

  return {
    $schema: DATASET_SCHEMA,
    id: "allergen-cross-reactivity",
    title: "Allergen cross-reactivity families",
    description:
      "Baked allergen cross-reactivity families (issue #153) — well-established, " +
      "clinically static cross-reaction clusters (birch-OAS, latex-fruit, crustacean " +
      "tropomyosin, finned-fish parvalbumin, mammalian-milk caseins, tree-nut and " +
      "legume clusters). Backs informational cross-reaction notes and the #691 allergy " +
      "safety belt. INFORMATIONAL, never diagnostic — cross-reactivity does not mean a " +
      "reaction is certain. Each family carries a peer-reviewed literature citation. " +
      "Committed + HUMAN-REVIEWABLE; regenerate with `npm run gen:allergen-cross-reactivity`.",
    citation: [
      {
        source:
          "Published allergy literature — pollen-food (Werfel 2015), latex-fruit " +
          "(Blanco 1994), shellfish tropomyosin (Lopata 2010), fish parvalbumin " +
          "(Sharp & Lopata 2014), mammalian-milk caseins (Restani 1999), tree-nut " +
          "(Goetz 2005), and peanut–lupin (Moneret-Vautrin 1999) cross-reactivity.",
        note: "Generic clinical reference data (not patient data, not medical advice); each family additionally carries its own peer-reviewed `citation`.",
      },
    ],
    identity: { keys: ["id"] },
    entries,
  };
}

function main() {
  const dataset = buildAllergenCrossReactivityDataset();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} allergen cross-reactivity families to ${OUT}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
