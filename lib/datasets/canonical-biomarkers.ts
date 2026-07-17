// The canonical biomarker reference dataset, loaded onto the curated-dataset
// framework (issue #860 Track B). This is the ONE deferred Track B dataset, and it
// adopts the framework DIFFERENTLY from the other twenty — deliberately, for two
// structural reasons the wave comments flagged:
//
//  1. BOOT-SEEDED, not read-only. Unlike mets/dri/…, its ranges are UPSERTed into
//     the `canonical_biomarkers` SQLite table on every boot (seedCanonicalBiomarkers)
//     and drive a flag reconcile gated by canonicalFlagsSignature() (see
//     lib/canonical-flags-version.ts + lib/migrations/boot-tasks.ts). The committed
//     JSON is therefore shared between this read layer and the boot task; both read
//     the SAME file so they can never diverge.
//
//  2. GENERATOR-OWNED, human-curated ORDER. lib/canonical-biomarkers.json is written
//     by scripts/gen-canonical-biomarkers.ts (an Anthropic call per category) and then
//     HUMAN-CURATED — its entry order is a reviewed grouping (lipids together, …), NOT
//     a deterministic name sort, so the "regenerate → byte-compare" fixed-point the
//     other datasets use does not hold offline. It also stays at its historical path
//     (not under lib/datasets/data/) because eight other modules + the boot seed import
//     it directly; moving/reshaping it would churn the boot path for no behavioral gain.
//
// So this module is a pure READ LAYER: it imports the byte-identical committed JSON,
// WRAPS it in the framework envelope in memory (adding the citations + identity keys
// the framework requires), validates it once with loadDataset(), and exposes the
// entries + a name-keyed matcher. The envelope's `entries` ARE the raw file's
// `biomarkers` — no value is copied or transformed, so the ranges/optimal bands stay
// exactly what the boot task seeds. The registry lists it for the linter; a DB-tier
// test (lib/__db_tests__/canonical-biomarkers-dataset.test.ts) proves a fresh boot
// seeds the SAME rows and the flag-version gate still recomputes on a range change.
//
// Identity note (#482): the framework identity here is the EXACT canonical `name` —
// "which curated row". That does NOT fight biomarkerFamily()/biomarkerFamilyKey()
// (lib/canonical-name.ts + lib/queries/medical.ts), which collapse ACROSS canonical
// names (Total/D2/D3 Vitamin D → one subject) for dedup/series/dismissal. They are
// different layers: this dataset must resolve each distinct canonical row, so its
// matcher keys on `name`; the family collapse stays the cross-row identity function.
//
// Pure — no DB, no network.

import rawCanonical from "../canonical-biomarkers.json";
import { DATASET_SCHEMA } from "./types";
import { loadDataset } from "./loader";
import { createMatcher, nameStrategy } from "./matcher";
import type { Biomarker } from "@/lib/curated-biomarkers";

// One canonical biomarker entry — the committed-file row shape (name + reference /
// optimal bands + unit + conversions + curated cadence/velocity). Re-exports the
// hand-curated Biomarker type so consumers keep one source of truth for the shape.
export type CanonicalBiomarkerEntry = Biomarker;

// The raw committed file: { $comment, biomarkers: [...] }. The generator owns its
// shape and order; this module never mutates it.
const raw = rawCanonical as { $comment?: string; biomarkers: Biomarker[] };

// The validated framework dataset. The envelope is assembled here (in memory) over the
// byte-identical committed entries — every range/optimal value is exactly the file's.
// Throws at module load if the committed data ever violates the contract (e.g. a row
// missing its `name` identity) — a loud, early failure, like the other datasets.
export const canonicalBiomarkersDataset = loadDataset<CanonicalBiomarkerEntry>({
  $schema: DATASET_SCHEMA,
  id: "canonical-biomarkers",
  title: "Canonical biomarker reference & longevity-optimal ranges",
  description:
    "Controlled vocabulary of canonical biomarker names plus adult reference (ref_*) " +
    "and longevity-optimal (optimal_*) ranges, sex-specific and age-banded variants, " +
    "unit conversions, retest cadence, and velocity thresholds. Seeded into the " +
    "canonical_biomarkers table and used to flag out-of-range readings and draw the " +
    "reference bands on biomarker charts. INFORMATIONAL, NOT MEDICAL ADVICE — ranges " +
    "vary by lab, assay, sex, and age. The committed source is lib/canonical-biomarkers.json " +
    "(generator-owned, human-curated); regenerate with `npm run gen:biomarkers`.",
  citation: [
    {
      source:
        "General adult clinical laboratory reference intervals (standard lab panels)",
      note: "ref_* reference bounds — informational; actual intervals vary by laboratory, assay, sex, and age.",
    },
    {
      source:
        "General adult longevity / healthspan literature (optimal-target ranges)",
      note: "optimal_* bounds reflect commonly cited longevity targets, often tighter than the lab reference range.",
    },
    {
      source:
        "Published pediatric reference intervals — CALIPER (Colantonio DA et al., Clin Chem 2012;58:854), Nathan & Oski's Hematology and Oncology of Infancy and Childhood, Nelson Textbook of Pediatrics / PALS, The Harriet Lane Handbook (Johns Hopkins), AAP / Pediatric Endocrine Society",
      url: "https://pubmed.ncbi.nlm.nih.gov/22371482/",
      note: "ranges_by_age pediatric bands; per-analyte source mapping in lib/curated-biomarkers.ts (AGE_BANDS).",
    },
  ],
  identity: { keys: ["name"] },
  entries: raw.biomarkers,
});

// Name-keyed matcher (case-insensitive). The refusal gate: a biomarker name the
// controlled vocabulary does not contain resolves to null, never a nearest guess.
const matcher = createMatcher(canonicalBiomarkersDataset, nameStrategy);

// The canonical biomarker entries in committed (human-curated) order — the single
// read surface over the same rows the boot task seeds.
export const CANONICAL_BIOMARKERS: CanonicalBiomarkerEntry[] =
  canonicalBiomarkersDataset.entries;

// The canonical biomarker row for an exact canonical name (case-insensitive), or null
// when the name is not in the controlled vocabulary.
export function canonicalBiomarkerForName(
  name: string
): CanonicalBiomarkerEntry | null {
  return matcher.match(name);
}
