// The supplement catalog × upper-limit join (issue #3156) — PURE, no DB, no network.
//
// Two questions live here, and they are the same question read in opposite
// directions:
//
//   * DISPLAY — when a UL warning fires on a nutrient, does one of the products
//     feeding it declare that it is above that limit ON PURPOSE? `formulationUlNote`
//     answers it, and the answer is appended to the warning's detail line.
//   * CENSUS — which catalogued products trip a UL at one of their OWN stated
//     servings? `catalogUlExceedances` answers it, and the guard in
//     lib/__tests__/catalog-ul-notes.test.ts requires every such product to carry a
//     reason (and every reason to name a nutrient its product really trips).
//
// WHY A SEPARATE MODULE. lib/dri.ts owns the UL arithmetic and every UL sentence;
// lib/supplement-catalog.ts owns the product data and imports nothing at runtime.
// Neither may import the other — dri.ts formatting a product-catalog lookup would
// couple the engine to the seed data, and the catalog importing dri.ts would close a
// cycle. The join is its own concept and lives in its own file.
//
// NEVER PRESCRIPTIVE, NEVER SOFTENING. The note explains a number; it does not shrink
// one. `ulWarningDetail` still states the same total against the same limit and still
// closes with "discuss with your clinician".

import {
  stackUlWarnings,
  type StackItem,
  type NutrientContribution,
} from "./dri";
import { normalizeIngredientDrafts } from "./intake-ingredients";
import {
  SUPPLEMENT_CATALOG,
  type SupplementCatalogEntry,
} from "./supplement-catalog";

// The band the catalog is curated against: a general adult. The seeded servings are
// what an adult label states, and the ruling on #3156 is about the ADULT upper limit
// ("80 mg zinc against an adult upper limit of 40 mg"). A pediatric profile's lower
// bands are a real question and a different one — this census makes no claim about
// them, and `formulationUlNote` is band-agnostic because it reads a warning that has
// already been computed for whoever is looking at it.
const CENSUS_AGE_YEARS = 40;

function norm(name: string): string {
  return name.trim().toLowerCase();
}

// The catalogued product for a stored item name, or null. EXACT name match (trimmed,
// case-folded) — the same identity the form's catalog prefill uses. Deliberately not
// fuzzy: a note that says "this product is meant to be this high" must be about THAT
// product, and a near-miss rename ("AREDS 2 generic") is a different bottle whose
// contents nobody here knows. A renamed item simply gets the ordinary generic warning.
export function catalogEntryByName(
  name: string,
  entries: readonly SupplementCatalogEntry[] = SUPPLEMENT_CATALOG
): SupplementCatalogEntry | null {
  const want = norm(name);
  if (!want) return null;
  return entries.find((e) => norm(e.name) === want) ?? null;
}

// The declared reason(s) that a nutrient's UL exceedance is intentional, for the
// products actually contributing to it — joined into one line, or null when no
// contributor declares anything for this nutrient.
//
// Scoped to the nutrient AND to the contributors: an AREDS 2 in the stack explains the
// zinc line and says nothing on the vitamin A line, and it explains nothing at all
// once it is no longer part of the total.
export function formulationUlNote(
  nutrientKey: string,
  contributors: readonly NutrientContribution[],
  entries: readonly SupplementCatalogEntry[] = SUPPLEMENT_CATALOG
): string | null {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const c of contributors) {
    const entry = catalogEntryByName(c.name, entries);
    if (!entry?.aboveUpperLimit) continue;
    for (const n of entry.aboveUpperLimit) {
      if (n.nutrient !== nutrientKey) continue;
      if (seen.has(n.reason)) continue;
      seen.add(n.reason);
      notes.push(n.reason);
    }
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

// One catalogued product exceeding a UL at one of its own stated servings.
export interface CatalogUlExceedance {
  name: string;
  dose: string;
  nutrient: string;
  total: number;
  ul: number;
  unit: "mg" | "mcg";
}

// Every (product, stated serving, nutrient) triple where the catalog's own seeded
// composition, taken exactly as the entry directs, lands above the adult UL.
//
// This is the reverse-lookup the guard needs, and it is computed rather than listed:
// the answer moves when an entry's ingredients change, when a new blend is seeded, or
// when the DRI table's bands are revised, and a hand-kept list would not.
//
// An entry whose label amounts do not parse is SKIPPED, not guessed at — the write
// boundary refuses those strings too (lib/intake-ingredients), so a catalog entry
// carrying one is a data bug for that file's own guards, not a silent zero here.
export function catalogUlExceedances(
  entries: readonly SupplementCatalogEntry[] = SUPPLEMENT_CATALOG
): CatalogUlExceedance[] {
  const out: CatalogUlExceedance[] = [];
  for (const entry of entries) {
    if (!entry.ingredients?.length) continue;
    const parsed = normalizeIngredientDrafts(
      entry.ingredients.map((i) => ({
        name: i.name,
        amount_text: i.amount ?? "",
      }))
    );
    if (!parsed.ok) continue;
    const ingredients = parsed.rows.map((r) => ({
      name: r.name,
      amount: r.amount,
      unit: r.unit,
    }));
    for (const dose of entry.dosages) {
      const item: StackItem = {
        name: entry.name,
        active: true,
        doseAmounts: [dose],
        ingredients,
      };
      for (const sex of ["male", "female"] as const) {
        for (const w of stackUlWarnings([item], CENSUS_AGE_YEARS, sex)) {
          if (
            out.some(
              (o) =>
                o.name === entry.name && o.dose === dose && o.nutrient === w.key
            )
          ) {
            continue;
          }
          out.push({
            name: entry.name,
            dose,
            nutrient: w.key,
            total: w.total,
            ul: w.ul,
            unit: w.unit,
          });
        }
      }
    }
  }
  return out;
}
