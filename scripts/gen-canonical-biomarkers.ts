// Pre-generate the canonical biomarker reference dataset (lib/canonical-biomarkers.json).
//
// Calls the Anthropic API once per category to produce structured reference +
// longevity-optimal ranges for common biomarkers, then writes the merged result
// to lib/canonical-biomarkers.json. The file is COMMITTED and meant to be
// HUMAN-REVIEWED before it is trusted — the ranges are informational, not
// medical advice, and can be wrong. No per-request cost at app runtime; this is
// a one-off (re)generation step.
//
//   ANTHROPIC_API_KEY=... npm run gen:biomarkers
//
// Runs in batches by category to stay within the output budget. Existing entries
// in the JSON are preserved unless --overwrite is passed (so hand-curated edits
// survive a regen by default).

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.HEALTH_AI_MODEL || "claude-sonnet-4-6";
const OUT = path.join(process.cwd(), "lib", "canonical-biomarkers.json");
const OVERWRITE = process.argv.includes("--overwrite");
// Re-apply only the curated pediatric age bands to the existing committed JSON,
// WITHOUT calling the model (no API key needed). Use this to refresh the age
// bands after editing AGE_BANDS below:  npx tsx scripts/gen-canonical-biomarkers.ts --age-bands-only
const AGE_BANDS_ONLY = process.argv.includes("--age-bands-only");
// Re-apply the curated static lab entries (CURATED_LABS) AND the age bands to the
// existing committed JSON, WITHOUT calling the model (no API key needed). Missing
// curated entries are appended (existing order + human edits preserved); use this
// after editing CURATED_LABS/AGE_BANDS:
//   npx tsx scripts/gen-canonical-biomarkers.ts --curated-only
const CURATED_ONLY = process.argv.includes("--curated-only");

// One age-banded reference/optimal override. Ages are WHOLE YEARS and the band is
// half-open [min_age, max_age); max_age null is open-ended. Mirrors
// lib/types.AgeBandedRange (kept structurally identical so the JSON round-trips).
interface AgeBandedRange {
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
interface ReproductiveStatusRange {
  ref_low: number | null;
  ref_high: number | null;
  note?: string | null;
}
type ReproductiveStatus = "premenopausal" | "postmenopausal";
type ReproductiveStatusRanges = Partial<
  Record<ReproductiveStatus, ReproductiveStatusRange>
>;

interface Biomarker {
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

// Curated pediatric (and adolescent) reference bands for the highest-impact
// age-dependent markers (issue #101). These REPLACE the adult top-level fields
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
const AGE_BANDS: Record<string, AgeBandedRange[]> = {
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
};

// Attach the curated age bands to the matching biomarker rows (by exact canonical
// name). Rows without a curated entry keep ranges_by_age null (adult fields only).
// A name in AGE_BANDS with no matching row is reported so a rename can't silently
// drop bands. Deterministic and API-free — this is what --age-bands-only runs.
function applyAgeBands(map: Map<string, Biomarker>): void {
  const byName = new Map(
    [...map.values()].map((b) => [b.name.toLowerCase(), b])
  );
  for (const [name, bands] of Object.entries(AGE_BANDS)) {
    const row = byName.get(name.toLowerCase());
    if (!row) {
      console.warn(`  age bands: no biomarker named "${name}" — skipped`);
      continue;
    }
    row.ranges_by_age = bands;
  }
}

// Biomarker concentrations can't be negative, so clamp any negative bound the
// model emits up to 0. And an optimal_high of 0 on a "lower_better" toxin
// ("ideally undetectable") is unattainable — background exposure means almost
// no one reads exactly 0 — and renders as a nonsensical "optimal ≤ 0". Drop the
// optimal band in that case; a realistic low threshold is left to human review
// of the committed JSON.
function normalizeBounds(b: Biomarker): Biomarker {
  const clamp0 = (n: number | null) => (n != null && n < 0 ? 0 : n);
  const out: Biomarker = {
    ...b,
    ref_low: clamp0(b.ref_low),
    ref_high: clamp0(b.ref_high),
    optimal_low: clamp0(b.optimal_low),
    optimal_high: clamp0(b.optimal_high),
  };
  if (out.direction === "lower_better" && out.optimal_high === 0) {
    out.optimal_low = null;
    out.optimal_high = null;
  }
  return out;
}

// Categories to generate, with the kind of biomarkers each should cover.
const BATCHES: { category: string; prompt: string }[] = [
  {
    category: "lipids",
    prompt:
      "Common lipid-panel and cardiovascular-risk blood biomarkers (total/LDL/HDL/VLDL/non-HDL cholesterol, triglycerides, ApoB, Lp(a), ratios).",
  },
  {
    category: "metabolic",
    prompt:
      "Glucose-metabolism and inflammation biomarkers (fasting glucose, HbA1c, fasting insulin, HOMA-IR, C-peptide, hs-CRP, homocysteine, uric acid).",
  },
  {
    category: "organ",
    prompt:
      "Liver, kidney, electrolyte and metabolic-panel biomarkers (ALT, AST, ALP, bilirubin, albumin, GGT, BUN, creatinine, eGFR, cystatin C, sodium, potassium, calcium, magnesium).",
  },
  {
    category: "cbc",
    prompt:
      "Complete-blood-count biomarkers (hemoglobin, hematocrit, WBC, RBC, platelets, MCV, RDW, neutrophils, lymphocytes) and iron studies (ferritin, iron, TIBC, transferrin saturation).",
  },
  {
    category: "hormones",
    prompt:
      "Thyroid, vitamin and hormone biomarkers (TSH, free T4, free T3, vitamin D 25-OH, B12, folate, total/free testosterone, estradiol, DHEA-S, cortisol, IGF-1, PSA).",
  },
  {
    category: "body",
    prompt:
      "Vitals and body-composition/DEXA metrics (systolic/diastolic blood pressure, resting heart rate, VO2 max, body-fat percentage, bone-density T-score, visceral fat, lean-mass index).",
  },
];

const TOOL: Anthropic.Tool = {
  name: "save_biomarkers",
  description: "Save the structured canonical biomarker reference dataset.",
  input_schema: {
    type: "object",
    properties: {
      biomarkers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Canonical Title-Case name, no method/specimen qualifiers",
            },
            category: {
              type: "string",
              enum: ["lab", "vitals", "scan", "genomics", "biomarker"],
            },
            unit: {
              type: ["string", "null"],
              description: "Canonical unit the ranges are expressed in",
            },
            ref_low: { type: ["number", "null"] },
            ref_high: { type: ["number", "null"] },
            optimal_low: { type: ["number", "null"] },
            optimal_high: { type: ["number", "null"] },
            direction: {
              type: "string",
              enum: ["higher_better", "lower_better", "in_range"],
            },
            note: {
              type: ["string", "null"],
              description: "Short caveat, e.g. 'varies by sex/age'",
            },
            conversions: {
              type: ["object", "null"],
              description:
                'Optional map of alternate unit -> factor, where value_in_alt * factor = value in the canonical unit (e.g. for LDL in mg/dL: {"mmol/L": 38.67}). Only include well-established, analyte-specific factors; omit when unsure.',
              additionalProperties: { type: "number" },
            },
          },
          required: ["name", "category", "direction"],
        },
      },
    },
    required: ["biomarkers"],
  },
};

const SYSTEM = `You produce a controlled vocabulary of canonical biomarker names plus their
reference and longevity-optimal ranges, for adults. For each biomarker emit one row:
- name: a clean, consistent Title-Case canonical name with NO method/specimen qualifiers
  (no "direct"/"calculated"/"serum"). E.g. "LDL Cholesterol", "Hemoglobin A1c".
- unit: the single canonical unit the ranges are expressed in (no conversion mixing).
- ref_low/ref_high: a standard lab reference range in that unit. Either bound may be null
  for one-sided ranges (e.g. LDL has only an upper bound).
- optimal_low/optimal_high: the range current longevity/healthspan literature considers
  optimal for adults (often tighter than, or absent from, the lab reference range). Null
  bounds allowed. Leave both null if there is no well-established optimal target.
- direction: "lower_better", "higher_better", or "in_range" (for U-shaped/in-range optima).
- note: a short caveat when relevant (e.g. "varies by sex/age"), else null.
- conversions: when the analyte is commonly reported in another unit, include a map of
  that unit to a factor where value_in_alt * factor = value in the canonical unit (e.g.
  cholesterol mg/dL from mmol/L: {"mmol/L": 38.67}; glucose: {"mmol/L": 18.02}). These are
  analyte-specific (mass↔molar depends on molar mass) — only include well-established
  factors and omit affine conversions (e.g. HbA1c % ↔ mmol/mol) and anything uncertain.
These are INFORMATIONAL, not medical advice. Be accurate and conservative; prefer null over
a guessed number. Call save_biomarkers exactly once.`;

async function genCategory(
  client: Anthropic,
  prompt: string
): Promise<Biomarker[]> {
  const msg = await client.messages
    .stream({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "save_biomarkers" },
      messages: [
        {
          role: "user",
          content: `Generate canonical biomarker entries for: ${prompt}`,
        },
      ],
    })
    .finalMessage();
  const toolUse = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  const arr = (toolUse?.input as any)?.biomarkers;
  return Array.isArray(arr) ? (arr as Biomarker[]) : [];
}

// Load the committed dataset into a name-keyed map (empty when missing/malformed).
function loadExisting(): Map<string, Biomarker> {
  const existing = new Map<string, Biomarker>();
  if (fs.existsSync(OUT)) {
    try {
      const cur = JSON.parse(fs.readFileSync(OUT, "utf8"));
      for (const b of cur.biomarkers ?? [])
        existing.set(b.name.toLowerCase(), b);
    } catch {
      // ignore a malformed existing file
    }
  }
  return existing;
}

// Apply age bands, sort by name, and write the committed JSON.
function writeDataset(map: Map<string, Biomarker>): void {
  applyAgeBands(map);
  const biomarkers = [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const out = {
    $comment:
      "Canonical biomarker reference dataset. Committed and HUMAN-REVIEWABLE. Regenerate with `npm run gen:biomarkers`. INFORMATIONAL, NOT MEDICAL ADVICE.",
    biomarkers,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${biomarkers.length} biomarkers to ${OUT}`);
  console.log("Review the ranges for plausibility before committing.");
}

// Surgically inject the curated age bands into the committed JSON, preserving its
// existing order, $comment, and every other field (the file has been human-curated
// since the last full generation, so a sort/rewrite would churn it destructively).
// Only the matching entries gain/refresh `ranges_by_age`. API-free.
function applyAgeBandsInPlace(): void {
  const cur = JSON.parse(fs.readFileSync(OUT, "utf8")) as {
    biomarkers?: Biomarker[];
  };
  const rows = cur.biomarkers ?? [];
  const byName = new Map(rows.map((b) => [b.name.toLowerCase(), b]));
  let applied = 0;
  for (const [name, bands] of Object.entries(AGE_BANDS)) {
    const row = byName.get(name.toLowerCase());
    if (!row) {
      console.warn(`  age bands: no biomarker named "${name}" — skipped`);
      continue;
    }
    row.ranges_by_age = bands;
    applied++;
  }
  fs.writeFileSync(OUT, JSON.stringify(cur, null, 2) + "\n");
  console.log(`Applied age bands to ${applied} biomarker(s) in ${OUT}`);
}

// Curated lab entries that don't require the model — well-established, standard
// reference ranges added to the committed dataset API-free (mirrors AGE_BANDS).
// Two groups:
//  1. CBC differential complements (issue #187): the existing "Neutrophils"/
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
  // ── Reproductive hormones: sex- and life-stage-aware (issue #200) ──────────
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
    note: "Sex- and cycle-dependent (pg/mL). Female = reproductive-age, spanning follicular→mid-cycle peak→luteal (the app can't know cycle phase), with no low bound so early-follicular / post-menopausal lows never false-flag; the lower post-menopausal range is already covered, so no age band. Male ~10–40. Replaces a prior male-ish single range that false-flagged normal female physiology. When the profile's reproductive_status is set, ranges_by_status overrides this (#202).",
    // Reproductive-status override (female physiology only, #202): a set menopausal
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
    note: "Sex- and life-stage-dependent (mIU/mL). Female reproductive-age spans luteal→mid-cycle (the app can't know cycle phase); post-menopausal FSH is many-fold higher and is resolved via the 51+ age band so it isn't false-flagged 'high'. When the profile's reproductive_status is set, ranges_by_status overrides the age proxy (#202).",
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
    // Reproductive-status override (female physiology only, #202): a set menopausal
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
    note: "Sex-dependent (mIU/mL). Female reproductive-age spans the luteal low → ovulatory LH surge (~95; the app can't know cycle phase) — an envelope that already contains the post-menopausal range (~8–59), so LH needs no age band. Male ~1.5–9.5. When the profile's reproductive_status is set, ranges_by_status refines this (#202).",
    // Reproductive-status override (female physiology only, #202). Mayo/endocrine
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
  },
];

// Curated per-analyte retest cadences, in DAYS, keyed by exact canonical name
// (issue #213, Phase 2). These replace the old flat 365-day staleness rule for the
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
const RETEST_DAYS: Record<string, number> = {
  "Hemoglobin A1c": 90,
  Glucose: 180,
  Insulin: 180,
  "HOMA-IR": 180,
  "C-Peptide": 180,
  TSH: 180,
  "Free T4": 180,
  "Free T3": 180,
  "Vitamin D, 25-Hydroxy": 180,
  "hs-CRP": 180,
  "Total Cholesterol": 365,
  "LDL Cholesterol": 365,
  "HDL Cholesterol": 365,
  Triglycerides: 365,
  "Non-HDL Cholesterol": 365,
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
const VELOCITY_PER_YEAR: Record<string, number> = {
  eGFR: 5,
  PSA: 0.75,
};

// Pure transform: return a copy of `biomarkers` with every CURATED_LABS entry
// present (its canonical definition replacing any same-named row, so edits here
// propagate), every AGE_BANDS override applied, and every RETEST_DAYS cadence
// attached. Deterministic and side-effect free — the committed JSON is a FIXED
// POINT of this (guarded by a unit test), so the generator and the committed
// dataset can't silently desync. Existing (non-curated) rows are cloned and keep
// their order; curated rows are appended in CURATED_LABS order.
export function curateBiomarkers(biomarkers: Biomarker[]): Biomarker[] {
  const curatedNames = new Set(CURATED_LABS.map((l) => l.name.toLowerCase()));
  const kept = biomarkers
    .filter((b) => !curatedNames.has(b.name.toLowerCase()))
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
  return out;
}

// Apply curateBiomarkers to the committed JSON in place, preserving its $comment
// and any other top-level fields. API-free.
function applyCurationInPlace(): void {
  const cur = JSON.parse(fs.readFileSync(OUT, "utf8")) as {
    biomarkers?: Biomarker[];
    [k: string]: unknown;
  };
  const before = cur.biomarkers ?? [];
  cur.biomarkers = curateBiomarkers(before);
  fs.writeFileSync(OUT, JSON.stringify(cur, null, 2) + "\n");
  console.log(
    `Curated dataset: ${cur.biomarkers.length} biomarkers (${CURATED_LABS.length} curated entries + age bands applied)`
  );
}

async function main() {
  // API-free refresh of the curated static labs + age bands over the existing JSON.
  if (CURATED_ONLY) {
    console.log("Applying curated lab entries + age bands to the dataset…");
    applyCurationInPlace();
    return;
  }

  // API-free refresh of just the curated age bands over the existing JSON.
  if (AGE_BANDS_ONLY) {
    console.log("Applying curated age bands to the existing dataset…");
    applyAgeBandsInPlace();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "ANTHROPIC_API_KEY not set. Set it and re-run `npm run gen:biomarkers`\n" +
        "(or use `--age-bands-only` to refresh just the pediatric age bands)."
    );
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });

  // Preserve existing curated entries (keyed by lowercased name) unless --overwrite.
  const existing = OVERWRITE ? new Map<string, Biomarker>() : loadExisting();

  const merged = new Map<string, Biomarker>(existing);
  // Seed the API-free curated lab entries so a full (re)generation — including
  // --overwrite — never drops them. An AI-returned row of the same name overrides.
  for (const lab of CURATED_LABS) {
    if (!merged.has(lab.name.toLowerCase()))
      merged.set(lab.name.toLowerCase(), lab);
  }
  for (const batch of BATCHES) {
    process.stdout.write(`Generating ${batch.category}… `);
    try {
      const rows = await genCategory(client, batch.prompt);
      let added = 0;
      for (const b of rows) {
        if (!b?.name) continue;
        const key = b.name.toLowerCase();
        if (!OVERWRITE && existing.has(key)) continue; // keep curated version
        merged.set(key, normalizeBounds(b));
        added++;
      }
      console.log(`${rows.length} returned, ${added} new/updated`);
    } catch (err) {
      console.log(
        `failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  writeDataset(merged);
}

// Run only when invoked as the CLI entry point — NOT when imported (e.g. by the
// drift unit test, which imports curateBiomarkers/CURATED_LABS). tsx sets
// process.argv[1] to this script's path when run directly.
if (process.argv[1]?.includes("gen-canonical-biomarkers")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
