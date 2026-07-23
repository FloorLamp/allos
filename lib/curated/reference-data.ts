// Curated biomarker reference DATA — the pediatric AGE_BANDS + the static
// CURATED_LABS table. Split out of lib/curated-biomarkers.ts (which keeps the
// policy tables + the curateBiomarkers transform + the shared types and re-exports
// these) so the ~2,000 lines of clinical reference data live on their own and a
// name/policy edit doesn't churn the whole file. Pure data; the transform that folds
// it into the committed JSON stays in curated-biomarkers.ts. INFORMATIONAL, NOT
// MEDICAL ADVICE — human-review the committed JSON before it is trusted.

import type { AgeBandedRange, Biomarker } from "../curated-biomarkers";

// Curated pediatric (and adolescent) reference bands for the highest-impact
// age-dependent markers. These REPLACE the adult top-level fields
// when the subject's age at the record's collection date falls in the band; sex
// overrides then resolve within the band. Ages are whole years, bands half-open
// [min_age, max_age). Values are informational (not medical advice) and rounded
// from published pediatric reference intervals.
//
// Sources (all pediatric reference intervals; consult the primary source before
// clinical use):
//  - CALIPER (Colantonio DA et al., Clin Chem 2012;58:854) — ALP, ferritin, TSH,
//    and the chemistry markers below (creatinine, AST, ALT, albumin, total
//    protein, calcium, phosphorus).
//  - Nathan & Oski's Hematology and Oncology of Infancy and Childhood — Hb, WBC,
//    neutrophil/lymphocyte differential (the physiologic lymphocyte predominance
//    of early childhood), and hematocrit / RBC / MCV / platelets by age.
//  - Nelson Textbook of Pediatrics / PALS — awake resting heart rate by age.
//  - The Harriet Lane Handbook (Johns Hopkins) — pediatric chemistry reference
//    intervals (creatinine, BUN, albumin, total protein, calcium, phosphorus,
//    total bilirubin, potassium).
//  - AAP / Pediatric Endocrine Society — vitamin D sufficiency in children
//    (≥20 ng/mL is considered sufficient, vs. the adult 30 ng/mL floor).
// Keys are the canonical biomarker names exactly as they appear in the dataset.
export const AGE_BANDS: Record<string, AgeBandedRange[]> = {
  // ALP soars during skeletal growth and spikes again at the pubertal growth
  // spurt (sex-split), then falls to the adult range — flagging a child's ALP
  // against the adult 40–129 U/L is the canonical false "high". (CALIPER/ARUP.)
  "Alkaline Phosphatase": [
    { min_age: 0, max_age: 1, ref_low: 80, ref_high: 450 },
    { min_age: 1, max_age: 10, ref_low: 140, ref_high: 420 },
    { min_age: 10, max_age: 13, ref_low: 130, ref_high: 560 },
    {
      min_age: 13,
      max_age: 15,
      ref_low: 57,
      ref_high: 468,
      ref_low_male: 116,
      ref_high_male: 468,
      ref_low_female: 57,
      ref_high_female: 254,
      note: "Pubertal growth-spurt peak; falls earlier in girls.",
    },
    {
      min_age: 15,
      max_age: 17,
      ref_low: 50,
      ref_high: 387,
      ref_low_male: 68,
      ref_high_male: 387,
      ref_low_female: 50,
      ref_high_female: 162,
    },
    { min_age: 17, max_age: 19, ref_low: 45, ref_high: 150 },
  ],
  // Hemoglobin: the infant physiologic nadir and lower childhood values mean the
  // adult 12–17.5 g/dL over-flags healthy children as anemic. (Nathan & Oski.)
  Hemoglobin: [
    {
      min_age: 0,
      max_age: 1,
      ref_low: 9.5,
      ref_high: 18,
      note: "Infant Hb varies widely by month (birth peak, ~2-month nadir); a whole-year band is coarse.",
    },
    { min_age: 1, max_age: 2, ref_low: 10.5, ref_high: 13.5 },
    { min_age: 2, max_age: 6, ref_low: 11.5, ref_high: 13.5 },
    { min_age: 6, max_age: 12, ref_low: 11.5, ref_high: 15.5 },
    {
      min_age: 12,
      max_age: 18,
      ref_low: 12,
      ref_high: 16,
      ref_low_male: 13,
      ref_high_male: 16,
      ref_low_female: 12,
      ref_high_female: 16,
    },
  ],
  // Physiologic leukocytosis of infancy/childhood; the adult 3.4–10.8 upper bound
  // over-flags healthy young children. (Nathan & Oski.)
  "White Blood Cell Count": [
    { min_age: 0, max_age: 1, ref_low: 6, ref_high: 17.5 },
    { min_age: 1, max_age: 6, ref_low: 5, ref_high: 15.5 },
    { min_age: 6, max_age: 12, ref_low: 4.5, ref_high: 13.5 },
    { min_age: 12, max_age: 18, ref_low: 4.5, ref_high: 11.5 },
  ],
  // The neutrophil/lymphocyte differential inverts in early childhood: lymphocytes
  // predominate until ~4–5 yr, so adult %s mis-flag a normal child's differential.
  Neutrophils: [
    { min_age: 0, max_age: 1, ref_low: 15, ref_high: 45 },
    { min_age: 1, max_age: 4, ref_low: 25, ref_high: 55 },
    { min_age: 4, max_age: 10, ref_low: 35, ref_high: 65 },
    { min_age: 10, max_age: 18, ref_low: 38, ref_high: 72 },
  ],
  Lymphocytes: [
    { min_age: 0, max_age: 1, ref_low: 40, ref_high: 75 },
    { min_age: 1, max_age: 4, ref_low: 35, ref_high: 65 },
    { min_age: 4, max_age: 10, ref_low: 30, ref_high: 55 },
    { min_age: 10, max_age: 18, ref_low: 25, ref_high: 50 },
  ],
  // Absolute neutrophil count (ANC): the floor runs lower in infancy/early
  // childhood (physiologic lymphocyte predominance) than the adult ~1.5×10^3/uL,
  // so flagging a well toddler's 1.2×10^3/uL against the adult floor is a false
  // "low". Values in cells/uL. (Nathan & Oski; pediatric hematology.)
  "Neutrophils, Absolute": [
    { min_age: 0, max_age: 1, ref_low: 1000, ref_high: 8500 },
    { min_age: 1, max_age: 4, ref_low: 1000, ref_high: 8500 },
    { min_age: 4, max_age: 10, ref_low: 1500, ref_high: 8000 },
    { min_age: 10, max_age: 18, ref_low: 1500, ref_high: 8000 },
  ],
  // Absolute lymphocyte count (ALC): high at birth, peaks in infancy, then falls
  // steadily toward the adult 1.0–4.8×10^3/uL by adolescence — so a healthy
  // infant's ~8×10^3/uL is NOT lymphocytosis. Values in cells/uL. (Nathan & Oski;
  // CHOP pediatric reference intervals.)
  "Lymphocytes, Absolute": [
    { min_age: 0, max_age: 1, ref_low: 4000, ref_high: 13500 },
    { min_age: 1, max_age: 4, ref_low: 3000, ref_high: 9500 },
    { min_age: 4, max_age: 10, ref_low: 1500, ref_high: 7000 },
    { min_age: 10, max_age: 18, ref_low: 1200, ref_high: 5200 },
  ],
  // Ferritin is high in infancy then lower through childhood than in adults; the
  // adult lower bound of 30 ng/mL over-flags healthy children as iron-deficient.
  Ferritin: [
    { min_age: 0, max_age: 1, ref_low: 25, ref_high: 200 },
    { min_age: 1, max_age: 10, ref_low: 10, ref_high: 140 },
    { min_age: 10, max_age: 18, ref_low: 15, ref_high: 120 },
  ],
  // TSH runs higher in infants/children than adults. (CALIPER.)
  TSH: [
    { min_age: 0, max_age: 1, ref_low: 1, ref_high: 8 },
    { min_age: 1, max_age: 6, ref_low: 0.7, ref_high: 6 },
    { min_age: 6, max_age: 12, ref_low: 0.6, ref_high: 5.5 },
    { min_age: 12, max_age: 18, ref_low: 0.5, ref_high: 4.9 },
  ],
  // Resting heart rate falls steadily from infancy to adulthood; a toddler's
  // normal ~120 bpm is not "tachycardic" against the adult 50–100. (Nelson/PALS.)
  "Resting Heart Rate": [
    { min_age: 0, max_age: 1, ref_low: 90, ref_high: 160 },
    { min_age: 1, max_age: 3, ref_low: 80, ref_high: 150 },
    { min_age: 3, max_age: 6, ref_low: 70, ref_high: 140 },
    { min_age: 6, max_age: 12, ref_low: 65, ref_high: 120 },
    { min_age: 12, max_age: 18, ref_low: 55, ref_high: 100 },
  ],
  // Creatinine tracks muscle mass, so it is very LOW in infants/young children and
  // climbs through childhood, splitting by sex in adolescence; the adult 0.6–1.3
  // mg/dL floor false-flags a healthy child's ~0.3 as "low" (or, read the other
  // way, masks a child's true elevation). (Harriet Lane; CALIPER enzymatic.)
  Creatinine: [
    {
      min_age: 0,
      max_age: 1,
      ref_low: 0.2,
      ref_high: 0.5,
      note: "Infant creatinine is low and month-dependent (a birth value reflecting maternal creatinine falls within days); a whole-year band is coarse.",
    },
    { min_age: 1, max_age: 3, ref_low: 0.2, ref_high: 0.5 },
    { min_age: 3, max_age: 5, ref_low: 0.3, ref_high: 0.6 },
    { min_age: 5, max_age: 12, ref_low: 0.3, ref_high: 0.7 },
    { min_age: 12, max_age: 15, ref_low: 0.5, ref_high: 1 },
    {
      min_age: 15,
      max_age: 18,
      ref_low: 0.5,
      ref_high: 1.1,
      ref_low_male: 0.6,
      ref_high_male: 1.1,
      ref_low_female: 0.5,
      ref_high_female: 1,
    },
  ],
  // AST runs higher in infancy/early childhood and settles toward the adult ceiling
  // by school age; scoring an infant against the adult 40 U/L over-flags "high".
  // Direction is lower_better (upper bound only), so bands set ref_high only.
  // (CALIPER; Harriet Lane.)
  AST: [
    { min_age: 0, max_age: 1, ref_low: null, ref_high: 80 },
    { min_age: 1, max_age: 3, ref_low: null, ref_high: 60 },
    { min_age: 3, max_age: 12, ref_low: null, ref_high: 50 },
  ],
  // ALT is meaningfully higher only in infancy (older children sit at or below the
  // adult 44 U/L, so no over-flagging there — older ages fall through to adult).
  // Direction is lower_better (upper bound only). (CALIPER; Harriet Lane.)
  ALT: [{ min_age: 0, max_age: 1, ref_low: null, ref_high: 55 }],
  // Total bilirubin is dominated by physiologic neonatal jaundice: a term newborn
  // peaks ~5–12 mg/dL in the first week and returns to the adult range within
  // weeks, so the adult 0.2–1.2 mg/dL over-flags essentially every newborn. Only an
  // infancy band is modeled (older children match adults). (Harriet Lane; AAP
  // hyperbilirubinemia guidance.)
  "Total Bilirubin": [
    {
      min_age: 0,
      max_age: 1,
      ref_low: 0,
      ref_high: 12,
      note: "Neonatal physiologic jaundice peaks in the first week then falls; a whole-year band is coarse (it can UNDER-flag a genuinely high bilirubin later in infancy) — interpret against age in days for a neonate. Conjugated/direct bilirubin is NOT raised here (direct hyperbilirubinemia is always pathologic).",
    },
  ],
  // BUN runs lower in infancy/childhood than the adult 7–20 mg/dL, so a healthy
  // child's ~5 mg/dL reads as a false "low". (Harriet Lane.)
  BUN: [
    { min_age: 0, max_age: 1, ref_low: 3, ref_high: 15 },
    { min_age: 1, max_age: 18, ref_low: 5, ref_high: 18 },
  ],
  // Albumin is lower in the neonate/young infant and reaches the adult range by
  // ~1 yr; the adult 3.5 g/dL floor over-flags a healthy newborn as "low".
  // Direction is higher_better. (Harriet Lane; CALIPER.)
  Albumin: [{ min_age: 0, max_age: 1, ref_low: 2.8, ref_high: 4.4 }],
  // Total protein is lower in infancy/early childhood (lower immunoglobulins) and
  // rises to the adult 6.0–8.3 g/dL by school age. (Harriet Lane; CALIPER.)
  "Total Protein": [
    { min_age: 0, max_age: 1, ref_low: 4.6, ref_high: 7.4 },
    { min_age: 1, max_age: 3, ref_low: 5.5, ref_high: 7.5 },
    { min_age: 3, max_age: 8, ref_low: 6, ref_high: 8 },
  ],
  // Calcium runs slightly higher in growing children (active bone mineralization),
  // so a child's ~10.6 mg/dL reads "high" against the adult 8.6–10.2. (Harriet
  // Lane; CALIPER.)
  Calcium: [
    { min_age: 0, max_age: 1, ref_low: 8.7, ref_high: 11 },
    { min_age: 1, max_age: 18, ref_low: 8.8, ref_high: 10.8 },
  ],
  // Phosphorus is MUCH higher in growing children (highest in infancy, falling
  // through adolescence) — the single most over-flagged pediatric chemistry against
  // the adult 2.5–4.5 mg/dL. (Harriet Lane; CALIPER.)
  Phosphorus: [
    { min_age: 0, max_age: 1, ref_low: 4.5, ref_high: 7.5 },
    { min_age: 1, max_age: 5, ref_low: 4.3, ref_high: 6.8 },
    { min_age: 5, max_age: 12, ref_low: 3.7, ref_high: 6 },
    { min_age: 12, max_age: 16, ref_low: 2.9, ref_high: 5.4 },
  ],
  // Platelets run higher in infancy/early childhood (physiologic thrombocytosis is
  // common), so a well infant's ~450–500 ×10^3/uL is not a true "high" against the
  // adult 150–400. (Nathan & Oski.)
  "Platelet Count": [
    { min_age: 0, max_age: 1, ref_low: 150, ref_high: 500 },
    { min_age: 1, max_age: 6, ref_low: 150, ref_high: 450 },
  ],
  // Hematocrit tracks hemoglobin (~3×): birth polycythemia, the ~2-month infant
  // nadir, lower childhood values, then the adolescent sex split. Mirrors the
  // Hemoglobin bands so the adult 34.9–50% doesn't over-flag healthy children.
  // (Nathan & Oski.)
  Hematocrit: [
    {
      min_age: 0,
      max_age: 1,
      ref_low: 28,
      ref_high: 54,
      note: "Infant Hct varies widely by month (birth polycythemia, ~2-month nadir); a whole-year band is coarse.",
    },
    { min_age: 1, max_age: 2, ref_low: 33, ref_high: 40 },
    { min_age: 2, max_age: 6, ref_low: 34, ref_high: 40 },
    { min_age: 6, max_age: 12, ref_low: 34, ref_high: 45 },
    {
      min_age: 12,
      max_age: 18,
      ref_low: 36,
      ref_high: 49,
      ref_low_male: 39,
      ref_high_male: 49,
      ref_low_female: 36,
      ref_high_female: 46,
    },
  ],
  // RBC count: high at birth, drops to the ~2-month physiologic nadir, then rises
  // through childhood — so a healthy infant at the nadir reads a false "low"
  // against the adult 3.92–5.65 ×10^6/uL. (Nathan & Oski.)
  "Red Blood Cell Count": [
    {
      min_age: 0,
      max_age: 1,
      ref_low: 3,
      ref_high: 5.4,
      note: "Infant RBC varies widely by month (birth high, ~2-month nadir); a whole-year band is coarse.",
    },
    { min_age: 1, max_age: 6, ref_low: 3.9, ref_high: 5.3 },
    { min_age: 6, max_age: 12, ref_low: 4, ref_high: 5.2 },
  ],
  // MCV is high at birth (neonatal macrocytosis) but children are physiologically
  // MICROcytic relative to adults (lowest in early childhood, rising with age), so
  // the adult 80 fL floor false-flags a healthy toddler's ~74 fL as "low"/micro-
  // cytic. (Nathan & Oski; Harriet Lane.)
  MCV: [
    {
      min_age: 0,
      max_age: 1,
      ref_low: 85,
      ref_high: 115,
      note: "Neonatal macrocytosis at birth falls sharply over the first months; a whole-year band is coarse.",
    },
    { min_age: 1, max_age: 5, ref_low: 70, ref_high: 86 },
    { min_age: 5, max_age: 12, ref_low: 75, ref_high: 90 },
    { min_age: 12, max_age: 18, ref_low: 78, ref_high: 98 },
  ],
  // Vitamin D: pediatric guidance (AAP / Pediatric Endocrine Society) treats
  // ≥20 ng/mL as sufficient in children, so the adult 30 ng/mL floor over-flags
  // an adequately-repleted child as "low". One 0–18 band lowers only the floor.
  "Vitamin D, 25-Hydroxy": [
    {
      min_age: 0,
      max_age: 18,
      ref_low: 20,
      ref_high: 100,
      note: "Pediatric sufficiency threshold (AAP / Pediatric Endocrine Society) is ≥20 ng/mL, below the adult 30 ng/mL floor.",
    },
  ],
  // Potassium runs higher in the neonate/young infant (and hemolysis of small
  // samples inflates it), so the adult 3.5–5.1 mmol/L ceiling over-flags a healthy
  // infant. Only an infancy band is modeled (older children match adults).
  // (Harriet Lane; Nelson.)
  Potassium: [{ min_age: 0, max_age: 1, ref_low: 3.7, ref_high: 6 }],
  // Nucleated RBC and immature granulocytes are normally ABSENT (≈0) in the
  // peripheral blood of children and adults, but present physiologically in the
  // NEONATE (highest at birth, clearing over the first week of life). A single
  // coarse infancy band keeps a newborn's normal reading in range WITHOUT relaxing
  // the adult ≈0 ceiling — so a pathologic NRBC / marrow left-shift still flags at
  // any older age. Direction is lower_better, so the bands set ref_high only (a
  // low/zero reading is never flagged). Whole-year bands are coarse for a birth
  // phenomenon that clears in days — interpret a neonate against age in days.
  // (Nathan & Oski's Hematology and Oncology of Infancy and Childhood.)
  "Nucleated Red Blood Cells": [
    {
      min_age: 0,
      max_age: 1,
      ref_low: null,
      ref_high: 10,
      note: "Term newborns normally show up to ~5–10 NRBC/100 WBC at birth, clearing within the first week; a whole-year band is coarse (it can UNDER-flag a genuinely raised NRBC later in infancy).",
    },
  ],
  "Nucleated Red Blood Cells, Absolute": [
    {
      min_age: 0,
      max_age: 1,
      ref_low: null,
      ref_high: 1.5,
      note: "Newborn absolute NRBC is elevated at birth and clears within the first week; a whole-year band is coarse.",
    },
  ],
  // Immature granulocytes carry a modest physiologic left shift in early infancy
  // (higher than the near-zero adult reference), so a single infancy band lifts
  // only the upper bound. (Sysmex IG parameter pediatric intervals; Nathan & Oski.)
  "Immature Granulocytes": [
    { min_age: 0, max_age: 1, ref_low: null, ref_high: 2 },
  ],
  "Immature Granulocytes, Absolute": [
    { min_age: 0, max_age: 1, ref_low: null, ref_high: 0.3 },
  ],
};

// Curated lab entries that don't require the model — well-established, standard
// reference ranges added to the committed dataset API-free (mirrors AGE_BANDS).
// Two groups:
//  1. CBC differential complements: the existing "Neutrophils"/
//     "Lymphocytes" entries hold the % form and "Monocytes"/"Eosinophils"/
//     "Basophils" the absolute (cells/uL) form, so the complementary form of each
//     needs its own entry (a % and an absolute count are not interconvertible
//     without the WBC).
//  2. Common clinical-lab analytes genuinely missing from the AI-generated
//     vocabulary but routinely mapped from a CCD/SHC (Total T4/T3, ESR, Direct
//     Bilirubin, LDH, CK, Anion Gap, Reticulocytes % and absolute).
// Ranges are INFORMATIONAL, not medical advice.
//
// The absolute cell-count entries use the bare canonical unit "cells/uL"; the
// count-concentration parser (lib/unit-conversions) now treats bare cell counts
// as exponent 0, so a value reported in any scaled spelling (10^3/uL, the UCUM
// 10*3/uL, 10*9/L, K/uL, Thousand/uL) converts through the generic ratio path —
// no per-entry `conversions` list needed.
//
// Sources (adult reference ranges; consult the primary source before clinical use):
//  - Adult WBC differential (relative % and absolute counts): Medscape/eMedicine
//    "Differential Blood Count" reference range; MedlinePlus "Blood differential".
//  - Pediatric absolute neutrophil/lymphocyte age bands: see AGE_BANDS above
//    (Nathan & Oski; CHOP pediatric reference intervals).
//  - Total T4/T3, Direct Bilirubin, LDH, CK (sex-specific), ESR (sex-specific),
//    Anion Gap, Reticulocytes: Mayo Clinic Laboratories & ARUP Consult adult
//    reference intervals (MedlinePlus for corroboration).
export const CURATED_LABS: Biomarker[] = [
  // ── Derived biological-age index (issue #157) ──────────────────────────────
  // PhenoAge — Levine's Phenotypic Age (2018): a "biological age" in YEARS
  // computed (not measured) from nine routine analytes + chronological age via a
  // mortality-risk model (lib/derived-biomarkers.phenoAge). It has no fixed
  // reference interval — it is interpreted RELATIVE to the person's chronological
  // age (a PhenoAge below chronological age is favorable) — so ref/optimal bounds
  // are intentionally null (no misleading high/low flag); direction is
  // lower_better for the trajectory machinery. Reference: Levine ME et al.,
  // "An epigenetic biomarker of aging for lifespan and healthspan," Aging 2018;
  // 10(4):573-591. INFORMATIONAL, NOT MEDICAL ADVICE.
  {
    // #1076: a computed composite, not a measured lab — categorized `derived` so it
    // routes to the Longevity bio-age hero and never onto the lab list / retest clock.
    // Unified with "Biological Age" (its display name), also `derived`.
    name: "PhenoAge",
    category: "derived",
    unit: "years",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Levine Phenotypic Age (2018), in years — a derived biological-age estimate from 9 analytes (albumin, creatinine, glucose, hs-CRP, lymphocyte %, MCV, RDW, ALP, WBC) plus chronological age. Interpreted relative to chronological age (lower = biologically younger); a population estimate with several years of error, not day-level precision.",
  },
  // ── Derived clinical index (issue #40) ─────────────────────────────────────
  // Triglyceride/HDL ratio — a simple, widely-cited surrogate for insulin
  // resistance and small-dense-LDL burden, computed (not measured) from the lipid
  // panel by lib/derived-biomarkers. The ratio is unit-SYSTEM specific: the cutoffs
  // below are for the US mg/dL convention (a mmol/L ratio is numerically different —
  // different molar masses), so the deriver converts both components to mg/dL first.
  // Cutoffs (informational, not medical advice): <2 favorable, ≥3.5 flags likely
  // insulin resistance. Sources: Salazar MR et al., Am J Cardiol 2012 (TG/HDL as an
  // IR surrogate); McLaughlin T et al., Ann Intern Med 2003.
  {
    name: "Triglyceride/HDL Ratio",
    category: "lab",
    unit: "ratio",
    ref_low: null,
    ref_high: 3.5,
    optimal_low: null,
    optimal_high: 2,
    direction: "lower_better",
    note: "Derived from the lipid panel (Triglycerides ÷ HDL, both mg/dL). Surrogate for insulin resistance / small-dense LDL; <2 favorable, ≥3.5 suggests insulin resistance. mg/dL-based — a mmol/L ratio differs.",
  },
  // ── CBC differential complements ──────────────────────────────────────────
  {
    name: "Neutrophils, Absolute",
    category: "lab",
    unit: "cells/uL",
    ref_low: 1500,
    ref_high: 8000,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Absolute neutrophil count (ANC). Adult ~1.5–8.0 ×10^3/uL; varies by age (see age bands).",
  },
  {
    name: "Lymphocytes, Absolute",
    category: "lab",
    unit: "cells/uL",
    ref_low: 1000,
    ref_high: 4800,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Absolute lymphocyte count (ALC). Adult ~1.0–4.8 ×10^3/uL; much higher in infancy/childhood (see age bands).",
  },
  // NB: named "…, Relative" (the standard clinical term for a %-differential),
  // NOT "…, %". normalizeCanonicalKey (lib/canonical-name) strips "%" as
  // punctuation, so "Monocytes, %" collapses to the token set {monocytes} and
  // collides with the pre-existing absolute "Monocytes" (cells/uL) entry — making
  // the percent entry UNREACHABLE via snapCanonicalName (the import routing). The
  // "relative" token keeps the key distinct: {monocytes, relative} ≠ {monocytes}.
  {
    name: "Monocytes, Relative",
    category: "lab",
    unit: "%",
    ref_low: 0,
    ref_high: 10,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Monocytes as a fraction of leukocytes (relative count). Companion to the absolute 'Monocytes' (cells/uL) entry.",
  },
  {
    name: "Eosinophils, Relative",
    category: "lab",
    unit: "%",
    ref_low: 0,
    ref_high: 6,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Eosinophils as a fraction of leukocytes (relative count). Companion to the absolute 'Eosinophils' (cells/uL) entry.",
  },
  {
    name: "Basophils, Relative",
    category: "lab",
    unit: "%",
    ref_low: 0,
    ref_high: 2,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Basophils as a fraction of leukocytes (relative count). Companion to the absolute 'Basophils' (cells/uL) entry.",
  },
  // ── Extended CBC / hematology (issue #723) ────────────────────────────────
  // Hematology analytes that import from real Epic CBCs but had NO canonical home,
  // so they landed ungrouped and range-less. Each abs-vs-% pair is TWO distinct
  // entries — a count (×10^3/uL) and a fraction (%) are NOT interconvertible
  // without the WBC, the same #482 identity discipline as the WBC differential
  // above — and the alternate LOINCs of each form route to its ONE entry
  // (lib/biomarker-loinc). Nucleated RBC and immature granulocytes are normally
  // ABSENT (≈0) in child/adult peripheral blood, so direction is lower_better
  // (only a high bound matters; a low/zero reading is normal). They run HIGH in
  // neonates, so each carries a coarse infancy age band (see AGE_BANDS) that keeps
  // a newborn's normal reading in range without relaxing the adult ≈0 ceiling.
  // These are incidental CBC-differential findings, not recurring monitors, so
  // they are intentionally left out of RETEST_DAYS/RETEST_WORTHY (default annual
  // cadence, dropped from the retest nudge as a one-off unless risk-elevated).
  // Sources: Nathan & Oski's Hematology and Oncology of Infancy and Childhood
  // (neonatal NRBC clearance); Sysmex IG parameter reference intervals; Mayo/ARUP.
  {
    name: "Nucleated Red Blood Cells",
    category: "lab",
    unit: "%",
    ref_low: null,
    ref_high: 0.5,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Nucleated (immature) red cells as a fraction of leukocytes (NRBC/100 WBC). Normally absent in children/adults; present at birth and clears within the first week (see infancy age band). Companion to the absolute NRBC count.",
  },
  {
    name: "Nucleated Red Blood Cells, Absolute",
    category: "lab",
    unit: "10^3/uL",
    ref_low: null,
    ref_high: 0.01,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Absolute nucleated-red-cell count (×10^3/uL). Normally ≈0 in children/adults; elevated at birth and clears within the first week (see infancy age band). Companion to the NRBC percentage.",
  },
  {
    name: "Immature Granulocytes",
    category: "lab",
    unit: "%",
    ref_low: null,
    ref_high: 0.5,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Immature granulocytes (metamyelocytes/myelocytes/promyelocytes) as a fraction of leukocytes — a left-shift marker. Adult reference ~0.0–0.5% (Sysmex IG%); mildly higher in early infancy (see age band). Companion to the absolute IG count.",
  },
  {
    name: "Immature Granulocytes, Absolute",
    category: "lab",
    unit: "10^3/uL",
    ref_low: null,
    ref_high: 0.03,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Absolute immature-granulocyte count (×10^3/uL) — a left-shift marker. Adult reference ~0.00–0.03 (Sysmex IG#); mildly higher in early infancy (see age band). Companion to the IG percentage.",
  },
  // Hemoglobin electrophoresis fractions — DISTINCT from Hemoglobin (g/dL) and
  // HbA1c (%). Adult ranges; the fetal→adult hemoglobin switch means an infant
  // differs markedly (HbF high, HbA low in the first ~year), so an infant reading
  // may flag against these adult ranges — no age band is modeled (the switch is
  // month-by-month in the first year; interpret an infant fraction against age).
  // Sources: Mayo Clinic Laboratories / ARUP adult hemoglobin-electrophoresis
  // reference intervals. INFORMATIONAL, not medical advice.
  {
    name: "Hemoglobin A",
    category: "lab",
    unit: "%",
    ref_low: 95.8,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Hemoglobin A (α2β2), the dominant adult hemoglobin, as a fraction of total hemoglobin on electrophoresis. The clinically meaningful abnormality is a REDUCED HbA (a structural/variant hemoglobinopathy displacing it), so only a lower bound is set. Physiologically LOW in infancy (fetal-hemoglobin switch).",
  },
  {
    name: "Hemoglobin A2",
    category: "lab",
    unit: "%",
    ref_low: 2.0,
    ref_high: 3.3,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Hemoglobin A2 (α2δ2) fraction on electrophoresis. An ELEVATED HbA2 (>~3.3%) is the classic marker of beta-thalassemia trait; a low HbA2 can accompany iron deficiency or alpha/delta-thalassemia. Adult range ~2.0–3.3%.",
  },
  {
    name: "Hemoglobin F",
    category: "lab",
    unit: "%",
    ref_low: 0,
    ref_high: 2.0,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Fetal hemoglobin (α2γ2) fraction on electrophoresis. Predominant at birth and normally falls to <~2% in adults; an elevated adult HbF occurs in hereditary persistence of fetal hemoglobin and some thalassemias/hemoglobinopathies. Physiologically HIGH in infancy (fetal-hemoglobin switch).",
  },
  // ── Missing common clinical-lab analytes ──────────────────────────────────
  {
    name: "Total T4",
    category: "lab",
    unit: "ug/dL",
    ref_low: 4.5,
    ref_high: 12,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Total thyroxine. Elevated by high thyroxine-binding globulin (pregnancy, estrogen); Free T4 is more specific.",
  },
  {
    name: "Total T3",
    category: "lab",
    unit: "ng/dL",
    ref_low: 80,
    ref_high: 200,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Total triiodothyronine.",
  },
  {
    name: "Direct Bilirubin",
    category: "lab",
    unit: "mg/dL",
    ref_low: 0,
    ref_high: 0.3,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Conjugated bilirubin.",
  },
  {
    name: "Lactate Dehydrogenase (LDH)",
    category: "lab",
    unit: "U/L",
    ref_low: 120,
    ref_high: 246,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Assay-dependent; hemolyzed specimens read falsely high.",
  },
  {
    name: "Creatine Kinase (CK)",
    category: "lab",
    unit: "U/L",
    ref_low: 26,
    ref_high: 308,
    ref_low_male: 39,
    ref_high_male: 308,
    ref_low_female: 26,
    ref_high_female: 192,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Higher in males; transiently elevated by exercise/muscle injury and higher with greater muscle mass and in some ancestries.",
  },
  {
    name: "Erythrocyte Sedimentation Rate (ESR)",
    category: "lab",
    unit: "mm/h",
    ref_low: 0,
    ref_high: 30,
    ref_low_male: 0,
    ref_high_male: 20,
    ref_low_female: 0,
    ref_high_female: 30,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Upper limit rises with age (roughly age/2 for men, (age+10)/2 for women), so this deliberately broad adult cutoff under-flags young adults rather than over-flag older ones.",
  },
  {
    name: "Anion Gap",
    category: "lab",
    unit: "mmol/L",
    ref_low: 4,
    ref_high: 16,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Varies widely by analyzer (direct-ISE methods run lower) and whether K+ is included in the calculation; range is intentionally broad.",
  },
  {
    name: "Reticulocytes",
    category: "lab",
    unit: "%",
    ref_low: 0.5,
    ref_high: 2.5,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Reticulocytes as a fraction of erythrocytes.",
  },
  {
    name: "Reticulocytes, Absolute",
    category: "lab",
    unit: "10^3/uL",
    ref_low: 25,
    ref_high: 75,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Absolute reticulocyte count (~25–75 ×10^3/uL; equivalently 25–75 ×10^9/L). Assay-dependent.",
  },
  // ── Reproductive hormones: sex- and life-stage-aware ──────────
  // Estradiol, FSH, and LH are strongly sex- and (for women) menstrual-cycle- and
  // menopause-dependent, so a single flat range false-flags normal physiology: a
  // healthy premenopausal woman's mid-cycle estradiol (~150–250 pg/mL) reads
  // "high" against a male-ish ~39 pg/mL ceiling, and post-menopausal FSH/LH — many-
  // fold higher than reproductive-age — read "high" against a reproductive ceiling.
  //
  // The flag mechanism composes sex × age (lib/reference-range): an age band
  // REPLACES the adult top-level fields, then the sex override resolves WITHIN the
  // band. We therefore express: adult male; adult female = the whole reproductive-
  // age envelope (the app never knows cycle phase, so it must span follicular →
  // mid-cycle surge → luteal without flagging); and, where the post-menopausal
  // range diverges enough to matter, a 51+ band (median age of menopause). FSH is
  // the only one that needs a band — post-menopausal FSH (~27–133) sits far above
  // the reproductive ceiling, so without a band it false-flags "high"; the band
  // carries a male range through too (the band replaces the adult fields, so a 51+
  // man must still resolve to a male range). Estradiol and LH need NO band: E2's
  // reproductive envelope has no low bound and a high ceiling, so the LOWER post-
  // menopausal values never false-flag; LH's reproductive envelope already spans
  // the ovulatory surge (~95) and so already contains the post-menopausal range
  // (~8–59). Low bounds are deliberately open (null) for the female/generic
  // envelopes so we introduce no NEW false-"low" on early-follicular, prepubertal,
  // HRT-suppressed, or post-menopausal physiology; the goal is to stop false highs,
  // not to add false lows. These are reproductive-adult ranges — a child's low
  // estradiol/FSH/LH is normal and NOT modeled here (no pediatric hormone bands);
  // the CCD test corpus is pediatric and carries none of these three.
  //
  // Ranges are rounded, conservative envelopes (a broad correct range beats a
  // narrow wrong one) from Mayo Clinic Laboratories adult reference intervals:
  //  - Estradiol (EEST, pg/mL): male ~10–40; premenopausal female ~follicular→mid-
  //    cycle peak (to ~357); postmenopausal <~30.
  //    https://www.mayocliniclabs.com/test-catalog/overview/81816
  //    Known limitation: E2 has no age band, so a post-menopausal woman's ceiling
  //    stays 400 — a post-menopausal HIGH estradiol (true range <~30) is not
  //    flagged. Omitted deliberately: a low 51+ ceiling would false-flag the many
  //    women still cycling at 51+ (menopause timing is wide). Mirror of the FSH
  //    band, which models the post-menopausal RISE.
  //  - FSH (mIU/mL): male ~1.0–12.0; premenopausal ~1.4 (luteal) → ~16.7 (mid-cycle
  //    peak); postmenopausal ~26.7–133.4.
  //    https://www.mayocliniclabs.com/test-catalog/overview/602753
  //  - LH (mIU/mL): male ~1.7–8.6; premenopausal ~1.0 (luteal) → ~95.6 (ovulatory
  //    surge); postmenopausal ~7.7–58.5.
  //    https://endocrinology.testcatalog.org/show/LH
  //
  // ── Cycle-phase reference ranges (ranges_by_cycle_phase, issue #718) ─────────
  // When the profile logs a menstrual cycle (#714), the reference range for these
  // four hormones is refined by the PHASE on the record's collection date, above the
  // coarse status/age proxies. The phase feed (lib/cycle.cyclePhaseOnDate) is
  // deliberately NON-PREDICTIVE, so it resolves menstrual/follicular/luteal with NO
  // distinct ovulatory phase — the ~1–2-day ovulatory window (and its mid-cycle
  // SURGE) falls inside the derived follicular span. So each `follicular` key below
  // is a follicular→ovulatory ENVELOPE (open low, ceiling = the mid-cycle peak) that a
  // menstrual date also reads; `luteal` is the luteal-phase range. Low bounds stay
  // OPEN (null), matching the coarse-envelope convention — the phase-specific HIGH
  // ceiling is the signal, and an open low adds no false-"low" on draw-timing
  // variation within a phase. Mapping rationale + trade-offs: full argument in PR #718.
  // Mayo Clinic Laboratories adult female cycle-phase intervals:
  //  - Estradiol (pg/mL): follicular 12.5–166, mid-cycle 85.8–498, luteal 43.8–211
  //    → follicular envelope high 498; luteal high 211.
  //  - FSH (mIU/mL): follicular 3.5–12.5, mid-cycle 4.7–21.5, luteal 1.7–7.7
  //    → follicular envelope high 21.5; luteal high 7.7.
  //  - LH (mIU/mL): follicular 2.4–12.6, mid-cycle 14.0–95.6, luteal 1.0–11.4
  //    → follicular envelope high 95.6; luteal high 11.4.
  //  - Progesterone (ng/mL): follicular ≤1.5, luteal 1.8–23.9 (Mayo test 8141) —
  //    the analyte with the LARGEST phase swing, so a mid-luteal value (~3–24) is
  //    normal-luteal but "high" against the follicular ≤1.5, the issue's motivating
  //    case. https://www.mayocliniclabs.com/test-catalog/overview/8141
  // INFORMATIONAL, NOT MEDICAL ADVICE — human-review before clinical use.
  {
    name: "Estradiol",
    category: "lab",
    unit: "pg/mL",
    ref_low: null,
    ref_high: 400,
    ref_low_male: 10,
    ref_high_male: 40,
    ref_low_female: null,
    ref_high_female: 400,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Sex- and cycle-dependent (pg/mL). Female = reproductive-age, spanning follicular→mid-cycle peak→luteal (the app can't know cycle phase), with no low bound so early-follicular / post-menopausal lows never false-flag; the lower post-menopausal range is already covered, so no age band. Male ~10–40. Replaces a prior male-ish single range that false-flagged normal female physiology. When the profile's reproductive_status is set, ranges_by_status overrides this.",
    // Reproductive-status override (female physiology only): a set menopausal
    // status resolves ahead of the age proxy. Postmenopausal E2 is ≤~30 pg/mL, so
    // this is what finally flags a genuinely post-menopausal HIGH estradiol (e.g.
    // 200 pg/mL) that the reproductive-age ceiling of 400 leaves unflagged — that
    // ceiling is deliberately KEPT for unset/premenopausal to avoid false-flagging
    // women still cycling at 51+. Mayo Clinic Labs adult intervals (test 81816):
    // premenopausal spans follicular→mid-cycle peak (~≤350); postmenopausal <~30.
    ranges_by_status: {
      premenopausal: {
        ref_low: null,
        ref_high: 400,
        note: "Reproductive-age envelope (follicular→mid-cycle→luteal); open low bound so early-follicular lows never false-flag.",
      },
      postmenopausal: {
        ref_low: null,
        ref_high: 30,
        note: "Postmenopausal E2 ≤~30 pg/mL; open low bound (HRT/atrophy lows aren't flagged). Lets a post-menopausal HIGH estradiol flag.",
      },
    },
    // Cycle-phase override (#718): resolves ABOVE ranges_by_status when the cycle log
    // covers the collection date. Follicular is a follicular→ovulatory envelope (Mayo
    // mid-cycle peak ~498) so the physiological estradiol peak isn't false-flagged;
    // luteal ceiling ~211. Open lows (no new false-"low").
    ranges_by_cycle_phase: {
      follicular: {
        ref_low: null,
        ref_high: 498,
        note: "Follicular→ovulatory envelope (Mayo mid-cycle peak ~498 pg/mL); menstrual dates read this too.",
      },
      luteal: {
        ref_low: null,
        ref_high: 211,
        note: "Luteal-phase estradiol up to ~211 pg/mL (Mayo).",
      },
    },
    conversions: {
      "pmol/L": 0.2724,
    },
  },
  {
    name: "Follicle Stimulating Hormone (FSH)",
    category: "lab",
    unit: "mIU/mL",
    ref_low: null,
    ref_high: 21,
    ref_low_male: 1,
    ref_high_male: 12.5,
    ref_low_female: 1,
    ref_high_female: 21,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Sex- and life-stage-dependent (mIU/mL). Female reproductive-age spans luteal→mid-cycle (the app can't know cycle phase); post-menopausal FSH is many-fold higher and is resolved via the 51+ age band so it isn't false-flagged 'high'. When the profile's reproductive_status is set, ranges_by_status overrides the age proxy.",
    ranges_by_age: [
      {
        min_age: 51,
        max_age: null,
        ref_low: null,
        ref_high: 135,
        ref_low_male: 1,
        ref_high_male: 20,
        ref_low_female: 1,
        ref_high_female: 135,
        note: "Post-menopausal (age ≥51, median menopause): FSH rises to ~27–133 mIU/mL; the low bound stays broad so HRT-suppressed values aren't false-flagged 'low'. Male ceiling widened for the age-related rise.",
      },
    ],
    // Reproductive-status override (female physiology only): a set menopausal
    // status resolves AHEAD of the 51+ age band. Mayo Clinic Labs adult intervals
    // (test 602753): premenopausal ~1–21 (luteal→mid-cycle peak); postmenopausal
    // ~25.8–134.8. Setting premenopausal on a 51+ woman therefore correctly narrows
    // her ceiling back to the reproductive 21 (status > age band). The postmenopausal
    // LOW bound is left OPEN (null), matching the 51+ age band and the postmenopausal
    // estradiol rationale: an HRT-suppressed FSH is normal, so the only meaningful
    // signal is the HIGH ceiling — a closed low would only introduce a false 'low'.
    ranges_by_status: {
      premenopausal: {
        ref_low: 1,
        ref_high: 21,
        note: "Reproductive-age FSH (luteal→mid-cycle peak).",
      },
      postmenopausal: {
        ref_low: null,
        ref_high: 134.8,
        note: "Postmenopausal FSH up to ~134.8 mIU/mL (Mayo/ARUP); open low bound so HRT-suppressed values aren't false-flagged 'low'.",
      },
    },
    // Cycle-phase override (#718): resolves above the 51+ age band and ranges_by_status
    // when the cycle log covers the collection date. Follicular→ovulatory envelope
    // (Mayo mid-cycle peak ~21.5); luteal ceiling ~7.7 — a luteal FSH is normally low.
    ranges_by_cycle_phase: {
      follicular: {
        ref_low: null,
        ref_high: 21.5,
        note: "Follicular→ovulatory envelope (Mayo mid-cycle peak ~21.5 mIU/mL); menstrual dates read this too.",
      },
      luteal: {
        ref_low: null,
        ref_high: 7.7,
        note: "Luteal-phase FSH up to ~7.7 mIU/mL (Mayo).",
      },
    },
  },
  {
    name: "Luteinizing Hormone (LH)",
    category: "lab",
    unit: "mIU/mL",
    ref_low: null,
    ref_high: 100,
    ref_low_male: 1.5,
    ref_high_male: 9.5,
    ref_low_female: 1,
    ref_high_female: 100,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Sex-dependent (mIU/mL). Female reproductive-age spans the luteal low → ovulatory LH surge (~95; the app can't know cycle phase) — an envelope that already contains the post-menopausal range (~8–59), so LH needs no age band. Male ~1.5–9.5. When the profile's reproductive_status is set, ranges_by_status refines this.",
    // Reproductive-status override (female physiology only). Mayo/endocrine
    // adult intervals: premenopausal spans the luteal low → ovulatory surge (~1–100);
    // postmenopausal up to ~58.5. The reproductive envelope already covers the
    // post-menopausal range, so status here mainly tightens the postmenopausal
    // ceiling; the LOW bound is left OPEN (null) — an HRT-suppressed LH is normal, so
    // (as with FSH and estradiol) a closed low would only introduce a false 'low'.
    ranges_by_status: {
      premenopausal: {
        ref_low: 1,
        ref_high: 100,
        note: "Reproductive-age LH (luteal low → ovulatory surge).",
      },
      postmenopausal: {
        ref_low: null,
        ref_high: 58.5,
        note: "Postmenopausal LH up to ~58.5 mIU/mL (Mayo/endocrine); open low bound so HRT-suppressed values aren't false-flagged 'low'.",
      },
    },
    // Cycle-phase override (#718): resolves above ranges_by_status when the cycle log
    // covers the collection date. Follicular→ovulatory envelope carries the LH SURGE
    // (Mayo mid-cycle peak ~95.6) so it isn't false-flagged; luteal ceiling ~11.4.
    ranges_by_cycle_phase: {
      follicular: {
        ref_low: null,
        ref_high: 95.6,
        note: "Follicular→ovulatory envelope carrying the LH surge (Mayo mid-cycle peak ~95.6 mIU/mL); menstrual dates read this too.",
      },
      luteal: {
        ref_low: null,
        ref_high: 11.4,
        note: "Luteal-phase LH up to ~11.4 mIU/mL (Mayo/endocrine).",
      },
    },
  },
  {
    // Progesterone (issue #718): the analyte with the LARGEST cycle-phase swing —
    // follicular ≤~1.5 ng/mL vs a mid-luteal peak up to ~24 — so it is the clearest
    // case for phase-aware ranges. Added as a curated lab (it had no canonical entry).
    // The BASE range is a reproductive-adult ENVELOPE (open low, ceiling = the luteal
    // peak) so that WITHOUT cycle data a normal-luteal value isn't false-flagged
    // "high" (the same coarse-envelope stance as E2/FSH/LH); the phase ranges then
    // TIGHTEN it — a follicular-date 15 flags "high" (a true catch the envelope
    // misses), a luteal-date 15 stays normal (the false-high the envelope would have
    // avoided anyway, now correct per phase). Male progesterone is low (<~1.4 ng/mL).
    // Postmenopausal ≤~0.5. Mayo test 8141; conversion 1 ng/mL = 3.18 nmol/L.
    // INFORMATIONAL, NOT MEDICAL ADVICE.
    name: "Progesterone",
    category: "lab",
    unit: "ng/mL",
    ref_low: null,
    ref_high: 23.9,
    ref_low_male: null,
    ref_high_male: 1.4,
    ref_low_female: null,
    ref_high_female: 23.9,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Cycle-phase-dependent (ng/mL). Female base is a reproductive envelope spanning follicular (≤~1.5) → mid-luteal peak (~24) since the app can't know cycle phase without a cycle log; open low so follicular/menstrual lows never false-flag. When the cycle log covers the collection date, ranges_by_cycle_phase refines it (follicular ≤1.5 vs luteal ≤24); when reproductive_status is set, ranges_by_status applies. Male ~≤1.4.",
    ranges_by_status: {
      premenopausal: {
        ref_low: null,
        ref_high: 23.9,
        note: "Reproductive-age envelope (follicular ≤~1.5 → mid-luteal peak ~24).",
      },
      postmenopausal: {
        ref_low: null,
        ref_high: 0.5,
        note: "Postmenopausal progesterone ≤~0.5 ng/mL (Mayo); open low bound. Lets a post-menopausal HIGH progesterone flag.",
      },
    },
    // Cycle-phase override (#718): the star case. Follicular ≤~1.5 ng/mL; luteal up to
    // ~24 — so a mid-luteal value reads its luteal range (normal) instead of flagging
    // "high" against the follicular/coarse range. Open lows (a low luteal progesterone
    // is draw-timing-dependent and out of scope, mirroring #714's tracking-not-
    // fertility boundary).
    ranges_by_cycle_phase: {
      follicular: {
        ref_low: null,
        ref_high: 1.5,
        note: "Follicular (and menstrual) progesterone ≤~1.5 ng/mL (Mayo). A value well above this on a follicular date is a genuine catch the coarse envelope misses.",
      },
      luteal: {
        ref_low: null,
        ref_high: 23.9,
        note: "Luteal-phase progesterone up to ~23.9 ng/mL (Mayo mid-luteal peak); a normal-luteal value is not flagged 'high'.",
      },
    },
    conversions: {
      "nmol/L": 0.3145,
    },
  },
  // ── Functional fitness markers (issue #158) ────────────────────────────────
  // MANUAL-ENTRY physical measurements (no lab draws) that are each independent,
  // well-published mortality/frailty predictors. They carry NO fixed reference or
  // optimal band — their context comes from the age/sex PERCENTILE + fitness-age
  // lookup over lib/datasets/data/fitness-norms.json (see lib/fitness-norms.ts), not a single
  // cutoff — so ref/optimal are intentionally null (no misleading high/low flag).
  // direction is higher_better for the trajectory machinery. Canonical names/units
  // MUST match lib/vitals-input.ts and the lib/datasets/data/fitness-norms.json keys byte-for-byte.
  // INFORMATIONAL, not medical advice.
  {
    name: "Grip Strength",
    category: "vitals",
    unit: "kg",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "higher_better",
    note: "Maximum handgrip (dynamometer), in kg. A whole-body strength proxy and independent mortality predictor; interpreted by age/sex percentile (Dodds et al. 2014), not a fixed cutoff.",
  },
  {
    name: "30-Second Chair Stand",
    category: "vitals",
    unit: "reps",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "higher_better",
    note: "Sit-to-stand repetitions in 30 seconds — a lower-body strength / frailty measure for older adults. Interpreted by age/sex percentile (Rikli & Jones Senior Fitness Test), not a fixed cutoff.",
  },
  {
    name: "Single-Leg Balance",
    category: "vitals",
    unit: "seconds",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "higher_better",
    note: "Unipedal stance time, eyes open (seconds; typically capped at 45 s). A postural-control / fall-risk measure; interpreted by age/sex percentile (Springer et al. 2007), not a fixed cutoff.",
  },

  // ── Blood group (immutable identity attributes) ─────────────────────────────
  // Qualitative, like LDL Pattern: a group/factor, not a measurement — no unit and
  // no reference band, so nothing can flag them. Curated because the sources name
  // them inconsistently and, without an entry here, a real blood-group reading has
  // no canonical identity to stack under: the AI emits canonical_name "ABO Blood
  // Group"/"Rh Type" (which resolved to nothing), and Epic reports ONE combined
  // "ABORh Interpretation" row (LOINC 19057-9 → "Blood Type").
  //
  // All three names are ALSO recognized by the qualitative classifier's
  // IMMUTABLE_ATTRIBUTE regex, so canonicalizing a reading here is what makes its
  // "never abnormal, never stale" verdict reachable by name as well as by LOINC.
  // No retest cadence on purpose — a blood group cannot change.
  {
    // #1076: immutable identity fact — `reference` so it displays on the passport
    // but never joins the lab list / retest clock (shares the genomics never-stale rule).
    name: "ABO Blood Group",
    category: "reference",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "ABO group (A, B, AB, or O). An immutable identity attribute — never flagged, never retested.",
  },
  {
    // #1076: immutable identity fact — `reference` (see ABO Blood Group).
    name: "Rh Type",
    category: "reference",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Rh(D) factor (positive or negative). An immutable identity attribute — never flagged, never retested.",
  },
  {
    // #1076: immutable identity fact — `reference` (see ABO Blood Group).
    name: "Blood Type",
    category: "reference",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: 'Combined ABO group + Rh factor as one result (e.g. "O Positive"), the form many EHRs report. An immutable identity attribute — never flagged, never retested.',
  },

  // ── Urinalysis dipstick (#918) ─────────────────────────────────────────────
  // The recurring AI-extraction coverage gap. These are the chemical dipstick pads,
  // reported QUALITATIVELY (Negative / Trace / 1+ … , where Negative is normal), so
  // they carry no numeric reference band — curated for RECOGNITION and grouping (so
  // they resolve to a stable entry instead of an ad-hoc name and are kept apart from
  // their serum namesakes). The urine specimen is part of the identity: urine glucose
  // is not serum Glucose, urine protein is not serum Total Protein. Positive-is-
  // abnormal qualitative FLAGGING is a separate follow-up (a new class in the #684
  // qualitative classifier); these entries just stop the silent miss (#918 §4).
  // INFORMATIONAL, NOT MEDICAL ADVICE.
  {
    name: "Protein, Urine",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine dipstick protein — a screen for kidney involvement. Qualitative (Negative/Trace/1+…); Negative is normal. Distinct from serum Total Protein.",
  },
  {
    name: "Glucose, Urine",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine dipstick glucose — normally absent; present when blood glucose exceeds the renal threshold. Qualitative (Negative is normal). Distinct from serum Glucose.",
  },
  {
    name: "Ketones, Urine",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine dipstick ketones — a marker of fat metabolism, raised in fasting, low-carbohydrate states, or uncontrolled diabetes. Qualitative (Negative is normal).",
  },
  {
    name: "Bilirubin, Urine",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine dipstick bilirubin — normally absent; its presence points to liver or bile-duct disease. Qualitative (Negative is normal). Distinct from serum Total/Direct Bilirubin.",
  },
  {
    name: "Blood, Urine",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine dipstick (occult) blood — detects hemoglobin/myoglobin. Qualitative (Negative is normal). A microscopic red-cell count is the separate 'Red Blood Cells, Urine' entry.",
  },
  {
    name: "Nitrite, Urine",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine dipstick nitrite — a positive suggests bacteria that convert nitrate to nitrite (a urinary-tract infection clue). Qualitative (Negative is normal).",
  },
  {
    name: "Leukocyte Esterase, Urine",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine dipstick leukocyte esterase — an enzyme from white blood cells, a marker of urinary-tract inflammation/infection. Qualitative (Negative is normal).",
  },
  {
    name: "Urobilinogen, Urine",
    category: "lab",
    unit: "mg/dL",
    ref_low: null,
    ref_high: 1,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine urobilinogen — a small amount (up to ~1 mg/dL) is normal; raised levels can reflect liver disease or hemolysis, and absence can reflect bile-duct obstruction.",
  },

  // ── Immunoglobulins (#918) ─────────────────────────────────────────────────
  // Serum immunoglobulin classes and the IgG subclasses. Quantitative (mg/dL). Adult
  // reference intervals vary by lab/assay; the bands here are representative adult
  // ranges. Distinct from Immunoglobulin E (Total), already curated. INFORMATIONAL,
  // NOT MEDICAL ADVICE.
  {
    name: "Immunoglobulin G",
    category: "lab",
    unit: "mg/dL",
    ref_low: 700,
    ref_high: 1600,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Total serum IgG — the most abundant antibody class, reflecting long-term/adaptive immunity. Low levels can signal immunodeficiency; high levels chronic infection or inflammation.",
  },
  {
    name: "Immunoglobulin A",
    category: "lab",
    unit: "mg/dL",
    ref_low: 70,
    ref_high: 400,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Serum IgA — the antibody class guarding mucosal surfaces (gut, airways). Selective IgA deficiency is the most common primary immunodeficiency.",
  },
  {
    name: "Immunoglobulin M",
    category: "lab",
    unit: "mg/dL",
    ref_low: 40,
    ref_high: 230,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Serum IgM — the first antibody class produced in a new infection, so a rise can indicate a recent or acute exposure.",
  },
  {
    name: "Immunoglobulin G Subclass 1",
    category: "lab",
    unit: "mg/dL",
    ref_low: 382,
    ref_high: 929,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "IgG1 — the largest IgG subclass, directed mainly at protein antigens. Measured in the workup of a suspected antibody deficiency.",
  },
  {
    name: "Immunoglobulin G Subclass 2",
    category: "lab",
    unit: "mg/dL",
    ref_low: 241,
    ref_high: 700,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "IgG2 — the IgG subclass directed mainly at polysaccharide antigens (e.g. encapsulated bacteria). A selective deficiency can raise susceptibility to such infections.",
  },
  {
    name: "Immunoglobulin G Subclass 3",
    category: "lab",
    unit: "mg/dL",
    ref_low: 22,
    ref_high: 176,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "IgG3 — an IgG subclass active against protein and viral antigens, with the shortest half-life of the four.",
  },
  {
    name: "Immunoglobulin G Subclass 4",
    category: "lab",
    unit: "mg/dL",
    ref_low: 4,
    ref_high: 86,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "IgG4 — the least abundant IgG subclass; markedly elevated levels are associated with IgG4-related disease.",
  },

  // ── Analytes the real-report audit confirmed as recurring gaps (#918) ────────
  // Ground-truthed against the source PDFs (units taken from the reports). Ranges
  // are conservative: null where the value is interpreted by ratio/context rather
  // than a fixed band (leptin is BMI/sex-dependent; urine albumin/creatinine are
  // dilution-dependent and read as the albumin/creatinine ratio). INFORMATIONAL,
  // NOT MEDICAL ADVICE.
  {
    name: "Leptin",
    category: "lab",
    unit: "ng/mL",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Leptin is a hormone made by fat tissue that signals energy stores to the brain; levels track body-fat mass and are strongly sex- and BMI-dependent, so no single reference band applies.",
  },
  {
    name: "Albumin, Urine",
    category: "lab",
    unit: "mg/dL",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine albumin screens for early kidney damage. It is interpreted as the albumin-to-creatinine ratio (normal <30 mg/g), not a fixed concentration, so no band is set here. Distinct from serum Albumin.",
  },
  {
    name: "Creatinine, Urine",
    category: "lab",
    unit: "mg/dL",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Urine creatinine reflects urine concentration and is used mainly to normalize other urine analytes (as a ratio); its own level varies with hydration, so no reference band applies. Distinct from serum Creatinine.",
  },
  {
    name: "Alpha-Fetoprotein (AFP)",
    category: "lab",
    unit: "ng/mL",
    ref_low: null,
    ref_high: 8.3,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "AFP is a protein used as a tumor marker (notably for liver and germ-cell cancers) and, in pregnancy, a screening marker. In non-pregnant adults it is normally low.",
  },
  {
    name: "Carcinoembryonic Antigen (CEA)",
    category: "lab",
    unit: "ng/mL",
    ref_low: null,
    ref_high: 3,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "CEA is a tumor marker used mainly to monitor colorectal and some other cancers. Levels can also be mildly raised by smoking and some benign conditions. The reference cutoff is higher in smokers.",
  },
  {
    name: "Hepatitis B Surface Antigen (HBsAg)",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "HBsAg is a marker of active hepatitis B infection. It is reported qualitatively; a negative (non-reactive) result is normal, and a positive result indicates current infection.",
  },
  {
    name: "Hepatitis B Surface Antibody (HBsAb)",
    category: "lab",
    unit: "mIU/mL",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "higher_better",
    note: "HBsAb (anti-HBs) reflects immunity to hepatitis B from vaccination or past infection; a level at or above 10 mIU/mL is generally considered protective.",
  },
  {
    name: "Hepatitis C Antibody (Anti-HCV)",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Anti-HCV screens for exposure to hepatitis C. It is reported qualitatively; a non-reactive result is normal, and a reactive result prompts confirmatory HCV RNA testing.",
  },
  {
    name: "BUN/Creatinine Ratio",
    category: "lab",
    unit: null,
    ref_low: 6,
    ref_high: 22,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "The ratio of blood urea nitrogen to creatinine helps distinguish causes of kidney impairment and hydration status; it is a calculated value with no units.",
  },
  {
    name: "LDL/HDL Ratio",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: 3.5,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "The ratio of LDL to HDL cholesterol is a summary marker of cardiovascular risk; lower is better. It is a calculated value with no units.",
  },

  // ── Vision analytes (issue #698) ───────────────────────────────────────────
  // Intraocular pressure (IOP) and visual acuity — the two most familiar eye
  // numbers, previously absent from the catalog (an imported/extracted IOP landed
  // uncataloged: no range, no flag, no trend). Both are PER-EYE (OD/OS), so each
  // gets its own canonical entry (right/left) plus an "eye unspecified" generic —
  // three per measure. The two eyes are the SAME assay but DIFFERENT subjects, so
  // they are kept as SEPARATE identities (not collapsed into one family): a chart
  // must show a left and a right pressure as two series and must never merge two
  // equal same-day readings. The "one glaucoma workup covers both eyes" collapse
  // lives only in the #700 follow-up adapter (lib/followup-iop), not in the global
  // biomarker identity. INFORMATIONAL, NOT MEDICAL ADVICE.
  //
  // IOP reference band 10–21 mmHg: the long-standing population range; >21 mmHg (>2
  // SD above the ~15.5 mmHg population mean) is the conventional ocular-hypertension
  // threshold and a glaucoma risk factor — NOT a diagnosis (many with high IOP never
  // develop glaucoma, and some develop it at normal pressure). direction "in_range"
  // (both a high and, rarely, a very low pressure matter). retest is the low/
  // dismissible tier (deliberately absent from RETEST_WORTHY) — not a lipid-panel
  // monitor. Sources: American Academy of Ophthalmology, "Eye Pressure"
  // (https://www.aao.org/eye-health/anatomy/eye-pressure); Glaucoma Research
  // Foundation, "What Is Considered Normal Eye Pressure Range?"
  // (https://glaucoma.org/articles/what-is-considered-normal-eye-pressure).
  {
    name: "Intraocular Pressure",
    category: "vitals",
    unit: "mmHg",
    ref_low: 10,
    ref_high: 21,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Fluid pressure inside the eye (tonometry), eye unspecified. Normal ~10–21 mmHg; above 21 is ocular hypertension, a glaucoma risk factor (not a diagnosis). AAO / Glaucoma Research Foundation.",
  },
  {
    name: "Intraocular Pressure, Right Eye",
    category: "vitals",
    unit: "mmHg",
    ref_low: 10,
    ref_high: 21,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Intraocular pressure of the right eye (OD), by tonometry. Normal ~10–21 mmHg; above 21 is ocular hypertension. Kept as a separate series from the left eye. AAO / Glaucoma Research Foundation.",
  },
  {
    name: "Intraocular Pressure, Left Eye",
    category: "vitals",
    unit: "mmHg",
    ref_low: 10,
    ref_high: 21,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Intraocular pressure of the left eye (OS), by tonometry. Normal ~10–21 mmHg; above 21 is ocular hypertension. Kept as a separate series from the right eye. AAO / Glaucoma Research Foundation.",
  },
  // Visual acuity — a QUALITATIVE Snellen-fraction reading ("20/20", "20/40", "6/6"),
  // where the numerator is a constant (the test distance) so there is no single
  // plottable magnitude. No numeric reference band, so nothing flags it and it
  // renders as a dated timeline instead of a misleading flat chart. Per-eye + a
  // generic entry. INFORMATIONAL, NOT MEDICAL ADVICE.
  {
    name: "Visual Acuity",
    category: "vitals",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Clearness of vision, eye unspecified, as a Snellen fraction (e.g. 20/20; 6/6 metric). Qualitative — no numeric reference band, so it is trended as a dated timeline, never flagged.",
  },
  {
    name: "Visual Acuity, Right Eye",
    category: "vitals",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Visual acuity of the right eye (OD) as a Snellen fraction (e.g. 20/20). Qualitative — no numeric reference band; trended as a dated timeline, never flagged. Kept as a separate series from the left eye.",
  },
  {
    name: "Visual Acuity, Left Eye",
    category: "vitals",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Visual acuity of the left eye (OS) as a Snellen fraction (e.g. 20/20). Qualitative — no numeric reference band; trended as a dated timeline, never flagged. Kept as a separate series from the right eye.",
  },
  // Periodontal analytes (#705) — the dental analogue of the vision analytes above:
  // measurable, flaggable, trendable dental-exam readings that reuse the biomarker
  // substrate (medical_records) rather than a parallel dental-readings table (#860/
  // #944), so a worsening perio trend is visible on the Biomarkers surface (the "is
  // it getting worse" question). Captured from a dental exam record via AI extraction
  // (into `results`), or entered manually. INFORMATIONAL, NOT MEDICAL ADVICE.
  {
    name: "Periodontal Probing Depth",
    category: "vitals",
    unit: "mm",
    ref_low: null,
    ref_high: 3,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Sulcus/pocket depth on periodontal probing, in millimetres (the deepest or a representative site). A healthy sulcus is ~1–3 mm; 4 mm and deeper indicates periodontal pocketing worth monitoring. American Academy of Periodontology.",
  },
  {
    name: "Bleeding on Probing",
    category: "vitals",
    unit: "%",
    ref_low: null,
    ref_high: 10,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Proportion of periodontal sites that bleed on gentle probing, as a full-mouth percentage. A full-mouth score under ~10% is consistent with periodontal stability; higher suggests active gingival inflammation. American Academy of Periodontology.",
  },
  {
    name: "Clinical Attachment Loss",
    category: "vitals",
    unit: "mm",
    ref_low: null,
    ref_high: 1,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Distance from the cemento-enamel junction to the base of the periodontal pocket, in millimetres — the cumulative attachment lost. 1–2 mm is mild, 3–4 mm moderate, ≥5 mm severe (2017 AAP/EFP staging). Tracks periodontitis progression over time.",
  },

  // ── Audiogram pure-tone thresholds (issue #713) ────────────────────────────
  // Per-EAR (right/left), per-FREQUENCY pure-tone air-conduction hearing
  // thresholds in decibels hearing level (dB HL) — the audiogram. Like the vision
  // (IOP/acuity, #698) and periodontal (#705) analytes above, these reuse the
  // biomarker substrate (medical_records) rather than a parallel audiogram table
  // (#860/#944 observation-substrate), so each series trends + flags on the
  // Biomarkers surface for free ("is my hearing getting worse at 4 kHz?"). Normal
  // hearing is ≤25 dB HL (WHO), so the band flags an elevated threshold; LOWER is
  // better. Each ear × frequency is its OWN trendable series that flags independently
  // — deliberately NOT collapsed into one biomarker family (see canonical-name.ts:
  // folding distinct ear/frequency measurements would let a normal frequency hide a
  // flagged one, a wrong all-clear). Captured from an uploaded audiogram report via AI
  // extraction (into `results`), or entered manually. INFORMATIONAL, NOT MEDICAL ADVICE.
  {
    name: "Hearing Threshold, Right Ear 250 Hz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the RIGHT ear at 250 Hz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Right Ear 500 Hz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the RIGHT ear at 500 Hz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Right Ear 1 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the RIGHT ear at 1 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Right Ear 2 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the RIGHT ear at 2 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Right Ear 4 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the RIGHT ear at 4 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it — 4 kHz is the classic noise-notch frequency. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Right Ear 8 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the RIGHT ear at 8 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Left Ear 250 Hz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the LEFT ear at 250 Hz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Left Ear 500 Hz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the LEFT ear at 500 Hz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Left Ear 1 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the LEFT ear at 1 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Left Ear 2 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the LEFT ear at 2 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Left Ear 4 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the LEFT ear at 4 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it — 4 kHz is the classic noise-notch frequency. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },
  {
    name: "Hearing Threshold, Left Ear 8 kHz",
    category: "vitals",
    unit: "dB HL",
    ref_low: null,
    ref_high: 25,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Pure-tone air-conduction hearing threshold for the LEFT ear at 8 kHz, in decibels hearing level (dB HL). Normal hearing is ≤25 dB HL (WHO); a higher number means the ear needs a louder tone to hear it. Its own per-ear, per-frequency audiogram series. American Speech-Language-Hearing Association / WHO.",
  },

  // ── Mental-health instruments (issue #716) ─────────────────────────────────
  // Validated screening-instrument TOTAL SCORES — PHQ-9 (depression), GAD-7
  // (anxiety) — as biomarker-shaped, trended series (the observation substrate,
  // #860/#944): the score is a numeric medical_records reading under this canonical
  // name, so it charts + trends like any biomarker with no parallel value store. The
  // per-item answers (for the PHQ-9 item-9 handling) live in the one new table
  // `instrument_responses`; the SCORE is here.
  //
  // DELIBERATELY carries NO numeric reference/optimal band (all bounds null, like
  // Visual Acuity above): the generic MedicalFlag machinery routes a flagged
  // biomarker into the Telegram/push morning digest BY NAME (getNewlyFlaggedBiomarkers),
  // and a "PHQ-9: 18 (high)" line landing on a shared/locked device is exactly the
  // crisis-adjacent harm case the #716 sensitivity decision forbids ("NEVER any
  // notification on any channel"). So the SEVERITY BAND (minimal/mild/moderate/…),
  // computed by the ONE pure lib/mental-health.severityBand(), is the on-screen "flag"
  // these scores carry, and the care-tier escalation for a SEVERE total or a positive
  // item 9 is the dedicated NON-DISMISSIBLE crisis finding (lib/mental-health +
  // mentalHealthCrisisItems), never a push. `direction` is informational only here
  // (lower is better) — with all bounds null nothing is ever flagged or nagged for a
  // retest (intentionally absent from RETEST_WORTHY/RETEST_DAYS). INFORMATIONAL, NOT
  // A DIAGNOSIS — a screening instrument, not a diagnostic. Public domain (PHQ/GAD).
  {
    name: "PHQ-9",
    category: "instrument",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Patient Health Questionnaire-9 total score (0–27), a validated screening instrument for depression severity. Severity bands: 0–4 minimal, 5–9 mild, 10–14 moderate, 15–19 moderately severe, 20–27 severe. Screening only, NOT a diagnosis. Item 9 asks about thoughts of self-harm. Public domain (Spitzer, Williams, Kroenke / Pfizer).",
  },
  {
    name: "GAD-7",
    category: "instrument",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Generalized Anxiety Disorder-7 total score (0–21), a validated screening instrument for anxiety severity. Severity bands: 0–4 minimal, 5–9 mild, 10–14 moderate, 15–21 severe. Screening only, NOT a diagnosis. Public domain (Spitzer, Kroenke, Williams, Löwe).",
  },

  // ── Substance-use instruments (issue #998) ─────────────────────────────────
  // Same contract as the mental-health instruments above: the TOTAL SCORE is a
  // biomarker-shaped, trended reading with ALL BOUNDS NULL — the severity band
  // (lib/substance-use.substanceSeverityBand) is the on-screen signal, never a
  // MedicalFlag, so a score can never ride the flagged-biomarker digest push
  // (substance data stays off every notification channel). A high score gets only
  // the calm on-surface discuss-with-a-clinician note — NEVER the crisis surface.
  // INFORMATIONAL, NOT A DIAGNOSIS. Band sources are in each note; AUDIT/DAST-10
  // item text is NOT reproduced anywhere in the app (see lib/substance-use.ts).
  {
    name: "AUDIT-C",
    category: "instrument",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "AUDIT-C total score (0–12), the 3-item alcohol-use screen (consumption items of the WHO AUDIT). Bands (UK PHE/NHS scoring): 0–4 lower risk, 5–7 increasing risk, 8–10 higher risk, 11–12 possible dependence; a score of 3+ (women) or 4+ (men) is commonly treated as a positive screen. Screening only, NOT a diagnosis. Public domain (Bush et al. 1998, VA).",
  },
  {
    name: "AUDIT",
    category: "instrument",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "AUDIT total score (0–40), the WHO 10-item Alcohol Use Disorders Identification Test. Risk zones (WHO manual): 0–7 lower risk, 8–15 increasing risk, 16–19 higher risk, 20–40 possible dependence. Screening only, NOT a diagnosis. Recorded as an outside-administered total (item text not reproduced in-app).",
  },
  {
    name: "DAST-10",
    category: "instrument",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "Drug Abuse Screening Test (DAST-10) total score (0–10) for non-alcohol drug use in the past 12 months. Bands (Skinner): 0 none reported, 1–2 low, 3–5 moderate, 6–8 substantial, 9–10 severe. Screening only, NOT a diagnosis. Recorded as an outside-administered total (item text not reproduced in-app; © H. A. Skinner / CAMH).",
  },
  // ── Vitamin D fractions + active metabolite (issue #1193) ─────────────────
  // The circulating 25-OH storage form is measured as two metabolites — D2
  // (ergocalciferol, dietary/supplemental) and D3 (cholecalciferol, made in skin) —
  // and a panel that breaks them out is reporting TWO distinct analytes on top of the
  // total. Each fraction is its OWN trendable series (biomarkerFamily gives it its own
  // identity, #1193) and must NOT inherit the total "Vitamin D, 25-Hydroxy" 30–100
  // sufficiency band: a low D2 is NORMAL for anyone not taking ergocalciferol and must
  // never flag "deficient". So the fractions carry NULL reference bands (informational
  // only — sufficiency is judged on the TOTAL 25-OH), while sharing the total's redraw
  // clock via biomarkerRetestIdentity. Same nmol/L conversion as the total.
  // Sources: Endocrine Society & IOM vitamin-D guidance (sufficiency assessed on total
  // 25-OH-D, not the individual fractions). INFORMATIONAL, NOT MEDICAL ADVICE.
  {
    name: "Vitamin D2, 25-Hydroxy",
    category: "lab",
    unit: "ng/mL",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    conversions: {
      "nmol/L": 0.4006,
    },
    note: "25-hydroxyvitamin D2 (ergocalciferol) fraction — its OWN trendable series, distinct from the total. No sufficiency band: a low D2 is normal for anyone not taking ergocalciferol, so vitamin-D status is assessed on the TOTAL 25-OH, never this fraction alone.",
  },
  {
    name: "Vitamin D3, 25-Hydroxy",
    category: "lab",
    unit: "ng/mL",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    conversions: {
      "nmol/L": 0.4006,
    },
    note: "25-hydroxyvitamin D3 (cholecalciferol) fraction — its OWN trendable series, distinct from the total. No sufficiency band: vitamin-D status is assessed on the TOTAL 25-OH, never this fraction alone.",
  },
  {
    // The ACTIVE hormone (calcitriol), a genuinely distinct analyte from the 25-OH
    // storage form (different metabolite, different unit, different indication —
    // hypercalcemia / sarcoidosis / CKD workups), so it keeps its OWN identity and is
    // excluded from both 25-OH families (vitaminDRetestFamily's 1,25/dihydroxy/
    // calcitriol exclusion regex). Adult reference ~18–72 pg/mL.
    // Source: Mayo/ARUP 1,25-dihydroxyvitamin D reference interval (adult, pg/mL).
    name: "Vitamin D, 1,25-Dihydroxy",
    category: "lab",
    unit: "pg/mL",
    ref_low: 18,
    ref_high: 72,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    conversions: {
      "pmol/L": 0.417,
    },
    note: "1,25-dihydroxyvitamin D (calcitriol) — the ACTIVE hormone, distinct from the 25-OH storage form. Adult ~18–72 pg/mL. Used in hypercalcemia / sarcoidosis / CKD workups, NOT for routine vitamin-D status (which is the 25-OH total).",
  },
  // ── Plain C-Reactive Protein (issue #1195) ────────────────────────────────
  // The standard-sensitivity CRP assay — a DIFFERENT test than hs-CRP (which is the
  // high-sensitivity CV-risk assay, its own entry). Plain CRP tracks acute
  // inflammation/infection with a higher measuring range and conventional cutoffs, so
  // it carries its OWN identity and is never folded onto hs-CRP. mg/L, ~<3 low / >10
  // suggests acute inflammation. conversions map a mg/dL reading onto the canonical.
  // Source: conventional clinical CRP reference (<10 mg/L normal; >10 acute-phase).
  {
    name: "C-Reactive Protein",
    category: "lab",
    unit: "mg/L",
    ref_low: null,
    ref_high: 10,
    optimal_low: null,
    optimal_high: 3,
    direction: "lower_better",
    conversions: {
      "mg/dL": 10,
    },
    note: "Standard-sensitivity CRP (acute inflammation/infection), mg/L — a DIFFERENT assay than hs-CRP (the CV-risk high-sensitivity test). ~<3 low, >10 suggests acute inflammation.",
  },
  // ── Fasting glucose (issue #1195) ─────────────────────────────────────────
  // Fasting glucose has its OWN diagnostic thresholds (70–99 normal / 100–125 pre-DM /
  // ≥126 DM) distinct from a random "Glucose", so it is a distinct entry (LOINC 1558-6
  // maps to it in lib/biomarker-loinc). Its own identity — NOT the A1c/eAG family and
  // NOT the random-glucose series. Source: ADA Standards of Care fasting-glucose
  // diagnostic thresholds. INFORMATIONAL, NOT MEDICAL ADVICE.
  {
    name: "Glucose, Fasting",
    category: "lab",
    unit: "mg/dL",
    ref_low: 70,
    ref_high: 99,
    optimal_low: 70,
    optimal_high: 90,
    direction: "in_range",
    conversions: {
      "mmol/L": 18.02,
    },
    note: "Fasting plasma glucose. ADA thresholds: 70–99 normal, 100–125 prediabetes, ≥126 diabetes (confirmed). Distinct from a random Glucose and from the A1c/eAG family.",
  },

  // ── Qualitative infection / serology / molecular results ───────────────────
  // Reported QUALITATIVELY (Reactive/Non-Reactive, Detected/Not Detected,
  // Positive/Negative), so they carry NO numeric reference band — curated for
  // RECOGNITION + canonical grouping, exactly like the ABO/dipstick entries above,
  // NOT for a range. Their flag polarity (a POSITIVE is bad) is already settled by
  // the LOINC → 'infection' class table in lib/biomarker-loinc (qualitativeClassForLoinc)
  // and the qualitative classifier — this just gives each a stable identity so a
  // result stacks under one series and dedups by LOINC instead of coining an ad-hoc
  // name. `direction: "in_range"` + null bounds = never a numeric flag. Category
  // `lab` (not `reference`) because — unlike an immutable blood group — an infection
  // result is a real clinical finding that can recur and is worth surfacing.
  {
    name: "RPR",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Rapid plasma reagin — syphilis screen. Qualitative (Reactive/Non-Reactive); a reactive result is followed by a confirmatory treponemal test. No numeric band.",
  },
  {
    name: "Hemoglobin Electrophoresis",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Hemoglobinopathy screen (sickle-cell / thalassemia trait). Reported as an interpretation (e.g. Normal / abnormal variant pattern), not a measured quantity. No numeric band.",
  },
  {
    name: "HIV Antigen/Antibody",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "HIV 4th-generation Ag/Ab combination screen. Qualitative (Reactive/Non-Reactive); a reactive result is confirmed by a supplemental assay. No numeric band.",
  },
  {
    name: "SARS-CoV-2 NAAT",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "SARS-CoV-2 (COVID-19) nucleic-acid amplification (PCR). Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "SARS-CoV-2 Antigen",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "SARS-CoV-2 (COVID-19) rapid antigen test. Qualitative (Positive/Negative). No numeric band.",
  },
  {
    name: "Influenza A NAAT",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Influenza A virus nucleic-acid amplification (PCR). Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "Influenza B NAAT",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Influenza B virus nucleic-acid amplification (PCR). Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "Influenza A Antigen",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Influenza A rapid antigen test. Qualitative (Positive/Negative). No numeric band.",
  },
  {
    name: "Influenza B Antigen",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Influenza B rapid antigen test. Qualitative (Positive/Negative). No numeric band.",
  },
  {
    name: "RSV NAAT",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Respiratory syncytial virus nucleic-acid amplification (PCR). Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "Streptococcus A NAAT",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Group A Streptococcus (pharyngitis) nucleic-acid amplification. Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "Group B Streptococcus",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Group B Streptococcus (GBS) screen — routine in pregnancy. Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "Chlamydia trachomatis NAAT",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Chlamydia trachomatis nucleic-acid amplification. Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "Neisseria gonorrhoeae NAAT",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Neisseria gonorrhoeae nucleic-acid amplification. Qualitative (Detected/Not Detected). No numeric band.",
  },
  {
    name: "HPV, High-Risk",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "High-risk human papillomavirus (pooled hrHPV) — cervical cancer screen. Qualitative (Positive/Negative). No numeric band.",
  },
  {
    name: "HPV Genotype 16",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "HPV genotype 16 (a high-risk type). Qualitative (Positive/Negative). Kept distinct from the pooled hrHPV result and from genotype 18/45. No numeric band.",
  },
  {
    name: "HPV Genotype 18/45",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "HPV genotype 18/45 (high-risk types). Qualitative (Positive/Negative). Kept distinct from the pooled hrHPV result and from genotype 16. No numeric band.",
  },
  {
    name: "Culture Organism",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: 'The organism identified by a microbiology culture (the value is the organism name, e.g. "Methicillin-Susceptible Staphylococcus aureus"). Qualitative identity, not a measurement — no numeric band.',
  },

  // ── Durable-immunity IgG titers ────────────────────────────────────────────
  // Vaccine/exposure immunity antibodies. Reported either qualitatively ("Immune")
  // or as an assay-specific numeric titer — BOTH forms carry the SAME canonical
  // identity here (an XDM ships one analyte both ways). Deliberately RANGELESS: the
  // "immune ≥ X" cutoff is assay-specific, and the immune-POSITIVE-is-GOOD verdict
  // is already owned by the LOINC → 'immunity' class (#516), not a numeric band.
  {
    name: "Rubella Antibody IgG",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Rubella IgG — immunity marker. Reported qualitatively (Immune/Non-Immune) or as an assay-specific titer; immune is favorable. No universal numeric band (assay-specific).",
  },
  {
    name: "Measles Antibody IgG",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Measles (rubeola) IgG — immunity marker. Reported qualitatively (Immune/Non-Immune) or as an assay-specific titer; immune is favorable. No universal numeric band (assay-specific).",
  },
  {
    name: "Mumps Antibody IgG",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Mumps IgG — immunity marker. Reported qualitatively (Immune/Non-Immune) or as an assay-specific titer; immune is favorable. No universal numeric band (assay-specific).",
  },
  {
    name: "Varicella Zoster Antibody IgG",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Varicella-zoster (chickenpox) IgG — immunity marker. Reported qualitatively (Immune/Non-Immune) or as an assay-specific titer; immune is favorable. No universal numeric band (assay-specific).",
  },

  // ── Prenatal cell-free-DNA (NIPT) screens ──────────────────────────────────
  // The trisomy screens carry a LOW-/HIGH-RISK axis (not presence positive/negative),
  // owned by the LOINC → 'screen' class (#687); fetal fraction is the run-QC metric
  // (never a health signal). All RANGELESS — a screen is a risk call, not a measured
  // analyte; fetal fraction carries a % unit for display but never flags (`qc` class).
  {
    name: "Trisomy 21 Screen",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Prenatal cell-free-DNA screen for trisomy 21 (Down syndrome). A low-/high-risk screen, not a diagnosis — a high-risk result is confirmed by diagnostic testing. No numeric band.",
  },
  {
    name: "Trisomy 18 Screen",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Prenatal cell-free-DNA screen for trisomy 18 (Edwards syndrome). A low-/high-risk screen, not a diagnosis. No numeric band.",
  },
  {
    name: "Trisomy 13 Screen",
    category: "lab",
    unit: null,
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Prenatal cell-free-DNA screen for trisomy 13 (Patau syndrome). A low-/high-risk screen, not a diagnosis. No numeric band.",
  },
  {
    name: "Fetal Fraction",
    category: "lab",
    unit: "%",
    ref_low: null,
    ref_high: null,
    optimal_low: null,
    optimal_high: null,
    direction: "in_range",
    note: "Fraction of cell-free DNA in a NIPT draw that is fetal (a run-quality metric, typically ≥4% for a valid result). A QC value, NOT a health signal — never flagged.",
  },

  // ── Gestational glucose challenge (the one NUMERIC addition, with a cutoff) ─
  // The 1-hour 50 g glucose challenge test (GCT), an OB screen with a well-established
  // screening threshold (commonly 135–140 mg/dL; the source names its 135 cutoff). A
  // value AT/ABOVE the cutoff prompts the diagnostic 3-hour OGTT. Distinct from fasting
  // and random Glucose. Source: ACOG gestational-diabetes screening. INFORMATIONAL.
  {
    name: "Glucose, Gestational Screen (50 g)",
    category: "lab",
    unit: "mg/dL",
    ref_low: null,
    ref_high: 135,
    optimal_low: null,
    optimal_high: null,
    direction: "lower_better",
    note: "1-hour 50 g glucose challenge (GCT) — gestational-diabetes screen. A value ≥ the lab's cutoff (here 135 mg/dL) prompts the diagnostic 3-hour OGTT. Distinct from fasting/random Glucose.",
  },
];
