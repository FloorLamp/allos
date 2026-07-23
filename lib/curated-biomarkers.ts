// Hand-curated biomarker reference DATA (not generator logic).
//
// This module holds the human-curated reference tables that shape the committed
// canonical dataset (lib/canonical-biomarkers.json): pediatric AGE_BANDS, the
// static CURATED_LABS entries, per-analyte RETEST_DAYS cadences, VELOCITY_PER_YEAR
// thresholds, and the pure curateBiomarkers() transform that folds them together.
// It was extracted out of scripts/gen-canonical-biomarkers.ts (issue #80) so the
// data lives under lib/ (consumed by the generator AND the drift-guard unit test)
// rather than a test reaching into scripts/. It is API-free and side-effect free —
// no Anthropic client, no filesystem access — so it is safe to import from lib/ and
// from tests. Ranges are INFORMATIONAL, not medical advice; human-review the
// committed JSON before it is trusted.

import { canonicalAliases, normalizeCanonicalKey } from "./canonical-name";

import { AGE_BANDS, CURATED_LABS } from "./curated/reference-data";

// Re-exported so every existing importer of the reference data keeps its
// `@/lib/curated-biomarkers` path (the data moved to ./curated/reference-data).
export { AGE_BANDS, CURATED_LABS };

// One age-banded reference/optimal override. Ages are WHOLE YEARS and the band is
// half-open [min_age, max_age); max_age null is open-ended. Mirrors
// lib/types.AgeBandedRange (kept structurally identical so the JSON round-trips).
export interface AgeBandedRange {
  min_age: number;
  max_age: number | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_low_male?: number | null;
  ref_high_male?: number | null;
  ref_low_female?: number | null;
  ref_high_female?: number | null;
  optimal_low?: number | null;
  optimal_high?: number | null;
  note?: string | null;
}

// One reproductive-status reference override (female physiology only). Mirrors
// lib/types.ReproductiveStatusRange so the JSON round-trips.
export interface ReproductiveStatusRange {
  ref_low: number | null;
  ref_high: number | null;
  note?: string | null;
}
export type ReproductiveStatus = "premenopausal" | "postmenopausal";
export type ReproductiveStatusRanges = Partial<
  Record<ReproductiveStatus, ReproductiveStatusRange>
>;

// Cycle-phase reference overrides (female physiology only) — issue #718. Mirrors
// lib/types.CyclePhaseRanges so the JSON round-trips. Keyed by the two phases the
// non-predictive cycle derivation resolves for hormones: `follicular` (also covering a
// menstrual date and, since the derived model has no distinct ovulatory phase, the
// mid-cycle surge → a follicular→ovulatory envelope) and `luteal`.
export type CyclePhaseRangeKey = "follicular" | "luteal";
export type CyclePhaseRanges = Partial<
  Record<CyclePhaseRangeKey, ReproductiveStatusRange>
>;

export interface Biomarker {
  name: string;
  category: string;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  optimal_low: number | null;
  optimal_high: number | null;
  // Sex-specific reference overrides (used in place of ref_low/ref_high when the
  // subject's sex matches). Optional — omit for sex-neutral analytes.
  ref_low_male?: number | null;
  ref_high_male?: number | null;
  ref_low_female?: number | null;
  ref_high_female?: number | null;
  direction: "higher_better" | "lower_better" | "in_range";
  ranges_by_age?: AgeBandedRange[] | null;
  // Reproductive-status reference overrides (female physiology only), for the
  // reproductive hormones. Highest precedence in lib/reference-range (above the age
  // band) when the subject is female and their reproductive_status is set.
  ranges_by_status?: ReproductiveStatusRanges | null;
  // Cycle-phase reference overrides (female physiology only) for the phase-dependent
  // reproductive hormones (issue #718). Highest precedence in lib/reference-range
  // (above ranges_by_status) when the subject is female and their cycle phase on the
  // record's collection date is derivable from the logged cycle history.
  ranges_by_cycle_phase?: CyclePhaseRanges | null;
  // Optional map of alternate unit -> factor (value_in_alt * factor = value in the
  // canonical unit). Consumed by lib/unit-conversions for cross-unit flagging.
  conversions?: Record<string, number> | null;
  // Recommended retest cadence (days) for the Upcoming retest signal, curated in
  // RETEST_DAYS below. NULL/absent falls back to lib/reference-range's flat 365-day
  // default. NOT a flag input (absent from FLAG_RELEVANT_FIELDS), so it never
  // triggers a flag re-derivation.
  retest_days?: number | null;
  // Curated per-analyte velocity threshold, in canonical UNITS PER YEAR, for the
  // biomarker-trajectory velocity rule (issue #41). A sustained change-per-time in
  // the analyte's "bad" direction (falling for higher_better, rising for
  // lower_better) exceeding this magnitude is worth flagging even while the value
  // is still in range. Curated CONSERVATIVELY in VELOCITY_PER_YEAR below (only
  // eGFR + PSA today). NULL/absent = no velocity rule for the analyte. NOT a flag
  // input (absent from FLAG_RELEVANT_FIELDS), so it never re-derives a flag.
  velocity_per_year?: number | null;
  note: string | null;
}

// Curated per-analyte retest cadences, in DAYS, keyed by exact canonical name
// These replace the old flat 365-day staleness rule for the
// Upcoming retest signal: a marker not listed here falls back to
// lib/reference-range.DEFAULT_RETEST_DAYS (365). Chosen from routine
// monitoring practice — INFORMATIONAL, not medical advice; human-review before
// clinical use. The cadence reflects how fast a value meaningfully moves and how
// often it's acted on, not a guarantee. 90≈quarterly, 180≈6-monthly, 365≈annual.
//  - HbA1c ~3 months: the ADA retests every 3 months when not at goal (a ~90-day
//    red-cell lifespan means shorter intervals don't reflect new glycemia).
//  - Fasting glucose / insulin, HOMA-IR, C-Peptide ~6 months: metabolic panel
//    monitored more often than a yearly lipid check when dysglycemia is in play.
//  - TSH / Free T4 / Free T3 ~6 months: thyroid is re-checked ~6-8 weeks after a
//    dose change and roughly twice a year once stable; 180d is the stable cadence.
//  - Vitamin D ~6 months: re-checked a few months after starting/adjusting repletion.
//  - hs-CRP ~6 months: inflammation trend, revisited within the year.
//  - Standard lipid panel ~annual once at goal (ApoB, LDL/HDL/Total/Trig, ratios).
//  - Lp(a) ~5 years: largely genetically set — a once-or-rarely measurement, so a
//    long cadence avoids nagging a stable value yearly.
export const RETEST_DAYS: Record<string, number> = {
  "Hemoglobin A1c": 90,
  Glucose: 180,
  "Glucose, Fasting": 180,
  Insulin: 180,
  "HOMA-IR": 180,
  "C-Peptide": 180,
  TSH: 180,
  "Free T4": 180,
  "Free T3": 180,
  "Vitamin D, 25-Hydroxy": 180,
  // The D2/D3 fractions share the total's redraw clock (biomarkerRetestIdentity), so
  // when a fraction is the newest family member it reads on the same 180d cadence
  // rather than the flat 365 fallback (#1193).
  "Vitamin D2, 25-Hydroxy": 180,
  "Vitamin D3, 25-Hydroxy": 180,
  "High-Sensitivity C-Reactive Protein (hs-CRP)": 180,
  "Total Cholesterol": 365,
  "LDL Cholesterol": 365,
  "HDL Cholesterol": 365,
  Triglycerides: 365,
  "Non-HDL Cholesterol": 365,
  "Triglyceride/HDL Ratio": 365,
  ApoB: 365,
  "Lipoprotein(a)": 1825,
  Ferritin: 365,
  Homocysteine: 365,
  "Uric Acid": 365,
  Creatinine: 365,
  eGFR: 365,
  "Vitamin B12": 365,
  "Testosterone, Total": 365,
  "Testosterone, Free": 365,
  PSA: 365,
};

// Liver/pancreatic enzyme analytes that labs report interchangeably in "U/L" and
// "IU/L" for the IDENTICAL µmol/min catalytic assay (issue #828). All six store the
// canonical unit "U/L", so a reading printed as "IU/L" would otherwise fail to
// convert — the unit parser keeps bare catalytic U ("enzyme" dimension) and the
// international-unit IU ("activity" dimension) physically separate (issue #759) — and
// its out-of-range flag would silently never derive (reintroducing #759 for this pair)
// while its trend series split by unit spelling. Attaching a factor-1 `conversions`
// entry ({ "IU/L": 1 }) to exactly these analytes lets an IU/L reading flag and share
// the U/L series. This is DELIBERATELY per-analyte and explicit — it does NOT make IU
// equal U globally; the #759 dimension split stands for every other analyte (a true
// international-unit U analyte still refuses a bare-U reading, and vice versa). Keyed
// by exact canonical name; applied in curateBiomarkers below (idempotent, so the
// committed JSON stays a fixed point of the --curated-only transform).
export const ENZYME_IU_INTERCHANGEABLE: string[] = [
  "Alanine Aminotransferase (ALT)",
  "Aspartate Aminotransferase (AST)",
  "Alkaline Phosphatase",
  "Gamma-Glutamyl Transferase (GGT)",
  "Amylase",
  "Lipase",
];

// Curated per-analyte velocity thresholds, in canonical UNITS PER YEAR, keyed by
// exact canonical name (issue #41). A sustained change in the analyte's "bad"
// direction (falling for a higher_better marker, rising for a lower_better one)
// exceeding this magnitude is flagged by the biomarker-trajectory velocity rule
// EVEN while the value is still in range — a slow drift a single-value flag never
// catches. Curated CONSERVATIVELY: only the two markers where a per-year rate is
// itself a recognized clinical signal. INFORMATIONAL, not medical advice.
//  - eGFR ~5 mL/min/1.73m²/yr: a sustained decline faster than the ~1/yr of
//    normal aging (KDIGO calls ">5/yr" rapid progression) warrants attention even
//    above the 60 CKD threshold.
//  - PSA ~0.75 ng/mL/yr: a PSA velocity above ~0.75/yr is a long-standing
//    prostate-cancer-risk threshold, meaningful even with a total PSA under 4.
export const VELOCITY_PER_YEAR: Record<string, number> = {
  eGFR: 5,
  PSA: 0.75,
};

// Retest-WORTHINESS tier (issue #546). The recurring-monitoring set — the analytes a
// clinician actually re-draws on a clock (lipids, glycemic, thyroid, renal, liver,
// the core CMP/CBC, inflammation, and the commonly-monitored/repleted nutritionals).
// An analyte OUTSIDE this set is an incidental one-off from a workup (heavy metals,
// PFAS, the allergen-specific IgE panel, trace minerals, LDL subfractions, urine
// microscopy, thyroid antibodies…): it shouldn't nag with the SAME standing as a lipid
// panel in the retest nudge, so — unless it is risk-elevated — the Upcoming retest
// signal drops an unlisted one-off from the nudge entirely (issue #587; a flagged
// one-off still surfaces on the Biomarkers flag/trajectory path) rather than nagging
// it like a lipid. A risk-elevated unlisted analyte keeps its clock. Curated CONSERVATIVELY and
// INFORMATIONAL (not medical advice); reviewed against routine-panel practice. Keyed
// by exact canonical name (matched family-aware by lib/biomarker-retest, so the
// vitamin-D 25-OH isoforms inherit "Vitamin D, 25-Hydroxy"'s worthiness).
//  - Recurring-monitoring rationale (all INFORMATIONAL): the lipid/glycemic/thyroid/
//    renal panels are the routinely-trended sets (ADA, ACC/AHA, KDIGO monitoring
//    practice); the CMP/CBC electrolyte + hepatic + hematologic core is what a
//    comprehensive panel re-measures; hs-CRP/ESR trend inflammation; ferritin/iron/
//    B12/folate/D/homocysteine/magnesium are the commonly-repleted nutritionals.
export const RETEST_WORTHY: string[] = [
  // Glycemic
  "Hemoglobin A1c",
  "Glucose",
  "Glucose, Fasting",
  "Insulin",
  "HOMA-IR",
  "C-Peptide",
  // Lipids
  "Total Cholesterol",
  "LDL Cholesterol",
  "HDL Cholesterol",
  "Triglycerides",
  "Non-HDL Cholesterol",
  "VLDL Cholesterol",
  "Apolipoprotein B (ApoB)",
  "Lipoprotein(a)",
  "Cholesterol/HDL Ratio",
  "Triglyceride/HDL Ratio",
  // Thyroid
  "Thyroid-Stimulating Hormone (TSH)",
  "Free T4",
  "Free T3",
  // Renal
  "Creatinine",
  "eGFR",
  "Blood Urea Nitrogen (BUN)",
  "Cystatin C",
  "Uric Acid",
  // Hepatic (LFTs) + protein
  "Alanine Aminotransferase (ALT)",
  "Aspartate Aminotransferase (AST)",
  "Alkaline Phosphatase",
  "Gamma-Glutamyl Transferase (GGT)",
  "Total Bilirubin",
  "Albumin",
  "Total Protein",
  // Electrolytes / CMP core
  "Sodium",
  "Potassium",
  "Chloride",
  "Carbon Dioxide",
  "Calcium",
  // CBC core
  "Hemoglobin",
  "Hematocrit",
  "White Blood Cell Count",
  "Platelet Count",
  "Red Blood Cell Count",
  "Mean Corpuscular Volume (MCV)",
  // Inflammation
  "High-Sensitivity C-Reactive Protein (hs-CRP)",
  "Erythrocyte Sedimentation Rate (ESR)",
  // Commonly-monitored / repleted nutritionals + iron studies
  "Vitamin D, 25-Hydroxy",
  "Ferritin",
  "Iron",
  "Total Iron-Binding Capacity (TIBC)",
  "Transferrin Saturation",
  "Vitamin B12",
  "Folate",
  "Homocysteine",
  "Magnesium",
  // Androgen / prostate monitoring (curated retest cadences already exist for these)
  "Testosterone, Total",
  "Testosterone, Free",
  "Prostate-Specific Antigen (PSA)",
];

// Category corrections for AI-GENERATED rows not in CURATED_LABS (#1076). The
// curated entries carry their corrected `category` inline; this table fixes the
// handful of model-emitted rows whose category the generator got wrong. Keyed by
// exact canonical name (case-insensitive), applied last in curateBiomarkers so the
// committed JSON re-derives categories from ONE source without a model re-run. The
// #482 principle: category is the surface-selector every consumer reads.
//   • "Biological Age" — the display name of PhenoAge (both computed composites) →
//     `derived`, unifying them onto the Longevity bio-age hero. PhenoAge itself is
//     a CURATED_LABS entry already corrected inline.
export const CATEGORY_OVERRIDES: Record<string, string> = {
  "Biological Age": "derived",
};

// Pure transform: return a copy of `biomarkers` with every CURATED_LABS entry
// present (its canonical definition replacing any same-named row, so edits here
// propagate), every AGE_BANDS override applied, every RETEST_DAYS cadence
// attached, and every CATEGORY_OVERRIDES correction applied. Deterministic and
// side-effect free — the committed JSON is a FIXED POINT of this (guarded by a unit
// test), so the generator and the committed dataset can't silently desync. Existing
// (non-curated) rows are cloned and keep their order; curated rows are appended in
// CURATED_LABS order.
export function curateBiomarkers(biomarkers: Biomarker[]): Biomarker[] {
  const curatedNames = new Set(CURATED_LABS.map((l) => l.name.toLowerCase()));
  // Orphan prune (generator idempotency under RENAME/REMOVE): when a curated entry
  // is renamed, its old name is added as a CANONICAL_ALIAS source (a non-canonical
  // spelling) and dropped from CURATED_LABS — but its previously-written JSON row
  // still exists here and, no longer matching curatedNames, would be KEPT as a
  // duplicate (the stale "Hepatitis B Surface Antigen" beside its "(HBsAg)" entry).
  // A row whose name is an alias SOURCE that REROUTES to a different analyte identity
  // is by definition not a canonical entry, so drop it: the alias routes that spelling
  // onto the real entry. The "different identity" guard is essential — a punctuation
  // variant alias like ["Thyroid Stimulating Hormone (TSH)" → "Thyroid-Stimulating
  // Hormone (TSH)"] normalizes source and target to the SAME key, so it must NOT prune
  // the real entry; only an alias whose source-key ≠ target-key (a genuine reroute,
  // e.g. "Hepatitis B Surface Antigen" → "…(HBsAg)") marks an orphan. Provenance-free
  // and idempotent (the committed JSON carries no such orphan, so a re-run no-ops).
  const orphanKeys = new Set(
    canonicalAliases()
      .filter(
        ([from, to]) =>
          normalizeCanonicalKey(from) !== normalizeCanonicalKey(to)
      )
      .map(([from]) => normalizeCanonicalKey(from))
  );
  const kept = biomarkers
    .filter(
      (b) =>
        !curatedNames.has(b.name.toLowerCase()) &&
        !orphanKeys.has(normalizeCanonicalKey(b.name))
    )
    .map((b) => ({ ...b }));
  const out: Biomarker[] = [...kept, ...CURATED_LABS.map((l) => ({ ...l }))];
  const byName = new Map(out.map((b) => [b.name.toLowerCase(), b]));
  for (const [name, bands] of Object.entries(AGE_BANDS)) {
    const row = byName.get(name.toLowerCase());
    if (row) row.ranges_by_age = bands;
  }
  for (const [name, days] of Object.entries(RETEST_DAYS)) {
    const row = byName.get(name.toLowerCase());
    if (row) row.retest_days = days;
  }
  for (const [name, vel] of Object.entries(VELOCITY_PER_YEAR)) {
    const row = byName.get(name.toLowerCase());
    if (row) row.velocity_per_year = vel;
  }
  // Enzyme analytes measured interchangeably in U/L and IU/L (#828): attach a
  // factor-1 IU/L conversion so an IU/L reading flags against the U/L canonical and
  // joins its trend series. Merge (don't clobber) any existing conversions, and stay
  // idempotent so the committed JSON remains a fixed point of curateBiomarkers.
  for (const name of ENZYME_IU_INTERCHANGEABLE) {
    const row = byName.get(name.toLowerCase());
    if (row) row.conversions = { ...(row.conversions ?? {}), "IU/L": 1 };
  }
  // #1076: fix the category of AI-generated rows not in CURATED_LABS (curated rows
  // already carry their corrected category inline, so this is idempotent for them).
  for (const [name, category] of Object.entries(CATEGORY_OVERRIDES)) {
    const row = byName.get(name.toLowerCase());
    if (row) row.category = category;
  }
  return out;
}
