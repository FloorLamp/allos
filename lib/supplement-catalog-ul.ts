// The supplement catalog × upper-limit join (issue #3156) — PURE, no DB, no network.
//
// Two questions live here, and they are the same question read in opposite
// directions:
//
//   * DISPLAY — when a UL warning fires on a nutrient, does one of the products
//     feeding it declare that it is above that limit ON PURPOSE, and is the person
//     taking an amount that product is formulated to deliver? `formulationUlNote`
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
//
// AND IT ONLY SPEAKS ABOUT WHAT IT CAN EXPLAIN. Two bounds, both read off the CATALOG
// rather than off the limit:
//
//   * a product's own contribution earns the "by design" sentence only when it is above
//     the limit AND no larger than what the catalog says that product contains at its
//     largest stated serving. Ten softgels of AREDS 2 is 400 mg of zinc — ten times the
//     limit, five times anything its label states — and no formula designed that.
//   * the sentence about the TOTAL is appended only when those contributions ARE the
//     total, at servings the product itself states. Anything else in the stack and the
//     note explains the product's share and says where the rest came from.
//
// A note that explained someone else's total would teach a person to dismiss a real
// warning, which is #3156's failure mode wearing the other face.

import { stackUlWarnings, type StackItem, type UlWarning } from "./dri";
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
// already been computed for whoever is looking at it. OPEN: on a pediatric band the
// note still renders the adult sentence ("above the general zinc limit by design")
// against a child's lower limit. That is a wording call on a safety surface and is
// the owner's, not this module's — nothing here decides it.
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

// A float slack for comparing two amounts the same engine derived. Doses multiply label
// amounts, so an arithmetically identical total can land a few ULPs away; nothing here
// should turn on that.
const AMOUNT_EPSILON = 1e-9;

// The totals a product reaches for one nutrient at the servings IT states — the bound
// the note is measured against. Computed from the same census the catalog guard uses,
// so it cannot drift from the seed data: reformulate the entry and the bound moves with
// it.
//
// The census is the ADULT band's, so a stated serving appears here only when it is over
// the ADULT limit. That is the bound this needs — a note is only ever considered for a
// contribution already above the reader's own limit — and on a lower band the omission
// can only WITHHOLD the sentence about the total, never invent one.
function statedServingTotals(
  entry: SupplementCatalogEntry,
  nutrientKey: string
): number[] {
  return catalogUlExceedances([entry])
    .filter((x) => x.nutrient === nutrientKey)
    .map((x) => x.total);
}

// Is this contributor's amount one the product is FORMULATED to deliver — above the
// limit, and no larger than its own largest stated serving?
//
// BOTH bounds are the catalog's; the limit only sets the floor. The predicate this
// replaced was bounded below and not above (`amount > ul`), so every over-serving
// passed it: at six softgels a person was told 240 mg was expected for this product, on
// the same reasoning that withholds the note at ONE softgel because that is a serving
// they are not taking. Six is equally a serving the product was not designed for, and
// the catalog prefills at a stated serving that the person is then free to edit.
//
// stackUlWarnings fires on STRICTLY greater, so a contribution sitting exactly at the
// limit is not above it: AREDS 2 at one softgel is 40 mg, exactly at the adult UL and
// over nothing, and "above the limit by design" is not a claim about it.
function contributionIsByDesign(
  amount: number,
  ul: number,
  statedTotals: readonly number[]
): boolean {
  if (statedTotals.length === 0) return false;
  return amount > ul && amount <= Math.max(...statedTotals) + AMOUNT_EPSILON;
}

// The one sentence that speaks about the TOTAL rather than about a product. It needs ONE
// product to be the whole of that total, at a serving its own label states — a number two
// bottles add up to is a number nobody formulated, whether they are two different
// products or the same one logged as a morning item and an evening item.
//
// When something else IS in the total, `REST_ELSEWHERE` says so: it explains nothing
// about the total and points at what the note does not cover, which is the difference
// between a line a person can act on and a line that quietly reassures them about
// someone else's zinc. And when several by-design products make up the whole total,
// neither sentence is true, so the note ends with the product facts and stops.
const TOTAL_EXPECTED = "The total is expected for this product.";
const REST_ELSEWHERE = "The rest of this total comes from your other items.";

// The fields of a UL warning this join reads. Taken as ONE argument rather than as
// loose parts, because the answer depends on the whole exceedance — the total and the
// limit decide whether a contributor's declaration explains it, so a caller must not
// be able to supply the contributors without them.
export type FormulationUlWarning = Pick<
  UlWarning,
  "key" | "total" | "ul" | "contributors"
>;

// The declared reason(s) that a nutrient's UL exceedance is intentional, for the
// products whose contribution really is what their own label states — joined into one
// line, with a closing sentence that says how much of the total those products account
// for. Null when no contributor declares anything for this nutrient at an amount it is
// formulated to deliver.
//
// Scoped to the nutrient, to the contributors, and to the product's own stated
// servings: an AREDS 2 in the stack explains the zinc line and says nothing on the
// vitamin A line, it explains nothing at all once it is no longer part of the total, and
// at ten softgels it explains nothing because no label states that.
//
// WHAT IT NEVER DOES is claim a total it does not account for. Contributions sum to the
// total exactly (lib/dri.summarizeStack builds both from the same reading), so
// `total - byDesign` IS everything else in the stack — and while that is above zero the
// note ends by saying so instead of calling the number expected. A multivitamin, an
// immune blend and a cold lozenge at 8 mg each beside an AREDS 2 is 120 mg, and no
// arrangement of those items makes 120 mg something a product expects.
export function formulationUlNote(
  warning: FormulationUlWarning,
  entries: readonly SupplementCatalogEntry[] = SUPPLEMENT_CATALOG
): string | null {
  const { key: nutrientKey, total, ul, contributors } = warning;
  const seen = new Set<string>();
  const notes: string[] = [];
  let byDesign = 0;
  let explainers = 0;
  let everyShareIsAStatedServing = true;
  for (const c of contributors) {
    const entry = catalogEntryByName(c.name, entries);
    if (!entry) continue;
    const declared = (entry.aboveUpperLimit ?? []).filter(
      (n) => n.nutrient === nutrientKey
    );
    if (declared.length === 0) continue;
    const stated = statedServingTotals(entry, nutrientKey);
    if (!contributionIsByDesign(c.amount, ul, stated)) continue;
    byDesign += c.amount;
    explainers += 1;
    if (!stated.some((t) => Math.abs(t - c.amount) <= AMOUNT_EPSILON)) {
      everyShareIsAStatedServing = false;
    }
    for (const n of declared) {
      if (seen.has(n.reason)) continue;
      seen.add(n.reason);
      notes.push(n.reason);
    }
  }
  if (notes.length === 0) return null;
  if (total - byDesign > AMOUNT_EPSILON) {
    notes.push(REST_ELSEWHERE);
  } else if (explainers === 1 && everyShareIsAStatedServing) {
    notes.push(TOTAL_EXPECTED);
  }
  return notes.join(" ");
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
