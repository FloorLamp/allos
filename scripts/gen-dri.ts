// Pre-generate the baked NIH DRI dataset (lib/dri.json) used to warn when a
// profile's TOTAL daily supplement intake per nutrient exceeds a Tolerable Upper
// Intake Level (UL) — the supplement-side twin of drug-interaction checking
// (issue #148).
//
// The Dietary Reference Intakes (DRIs) — Tolerable Upper Intake Levels (ULs) and
// Recommended Dietary Allowances (RDAs) — are PUBLIC-DOMAIN reference values
// published by the NIH Office of Dietary Supplements (ODS) and the National
// Academies. This script writes the curated, PUBLIC values below — by nutrient,
// age band, and (where they differ) sex — to lib/dri.json.
//
// Mirrors the gen-mets.ts → lib/mets.json pattern: the JSON is COMMITTED and
// HUMAN-REVIEWABLE, and the values are INFORMATIONAL reference figures, NOT
// medical advice or dosing guidance. Like gen-mets (and unlike the biomarker
// generator) this needs NO API key — the DRI values are well-established public
// constants curated inline, so generation is fully deterministic:
//
//   npm run gen:dri
//
// CRITICAL — supplemental vs total basis: some ULs apply to SUPPLEMENTAL intake
// only (magnesium's UL is from products/pharmacologic agents, not food/water;
// likewise niacin, folic acid, and supplemental vitamin E), while others apply to
// TOTAL intake from all sources (vitamin A, D, calcium, iron, …). Each nutrient
// carries a `basis` flag so the checker states the right thing. The app only ever
// KNOWS supplemental intake, so the comparison (supplemental sum > UL) is sound for
// BOTH bases — a total-basis UL exceeded by supplements alone is definitely
// exceeded once food is added — but the wording differs, so the flag is load-
// bearing (see lib/dri.ts). The `iu` factor (canonical units per IU) converts the
// IU dose forms that appear in the supplement catalog (vitamins A, D, E).
//
// Anti-drift: the committed lib/dri.json is a FIXED POINT of buildDriDataset() and
// every nutrient the summer resolves must exist here — both pinned by
// lib/__tests__/dri-dataset.test.ts, so the generator and the committed file
// can't silently diverge.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(process.cwd(), "lib", "datasets", "data", "dri.json");

// One age/sex band of reference values. Ages are WHOLE YEARS and the band is
// half-open [min_age, max_age); max_age null is open-ended (adults). `sex` narrows
// a band to one physiology (used for RDA where it differs); omit for sex-neutral
// bands. `ul`/`rda` are in the nutrient's canonical `unit`; null where none is
// established.
export interface DriBand {
  min_age: number;
  max_age: number | null;
  sex?: "male" | "female";
  ul: number | null;
  rda: number | null;
}

// One nutrient's reference dataset.
export interface DriNutrient {
  // Stable key referenced by the name→nutrient matchers in lib/dri.ts.
  key: string;
  // Display label for the warning copy.
  label: string;
  // Canonical unit the ul/rda and the summed intake are expressed in ("mg"/"mcg").
  unit: "mg" | "mcg";
  // Which intake the UL applies to. "supplemental" → the UL is about supplement/
  // product intake only (magnesium, niacin, folic acid, supplemental vit E);
  // "total" → the UL is about intake from all sources (most vitamins/minerals).
  basis: "supplemental" | "total";
  // Canonical units per International Unit, for the IU dose forms in the catalog
  // (vitamins A/D/E). Absent for nutrients never dosed in IU.
  iu?: number | null;
  // Short caveat surfaced nowhere but the JSON — human-review context.
  note?: string | null;
  bands: DriBand[];
}

// Curated NIH DRI values (ULs + RDAs), by nutrient / age band / sex. PUBLIC-DOMAIN
// figures from the NIH Office of Dietary Supplements nutrient fact sheets and the
// National Academies DRI tables (https://ods.od.nih.gov/factsheets/list-all/ and
// https://nap.nationalacademies.org/read/11537). Adult bands are 19+ (max_age
// null); pediatric bands are included so a child profile scores against a child UL
// (a toddler's magnesium UL is 65 mg, not 350). INFORMATIONAL reference values,
// NOT medical advice — human-review before trusting.
//
// Only nutrients that (a) appear in the supplement catalog vocabulary
// (lib/supplement-catalog.ts) and (b) carry an established NIH UL are included; a
// nutrient with no UL (potassium, chromium, …) is intentionally omitted — there is
// nothing to warn against.
const NUTRIENTS: DriNutrient[] = [
  // ── Fat-soluble vitamins ────────────────────────────────────────────────
  {
    key: "vitamin_a",
    label: "Vitamin A",
    unit: "mcg",
    basis: "total",
    iu: 0.3, // 1 IU retinol = 0.3 mcg RAE
    note: "UL is for preformed vitamin A (retinol) from all sources. IU forms assumed to be retinol (0.3 mcg RAE/IU); provitamin-A carotenoids are not toxic and are not modeled.",
    bands: [
      { min_age: 1, max_age: 4, ul: 600, rda: 300 },
      { min_age: 4, max_age: 9, ul: 900, rda: 400 },
      { min_age: 9, max_age: 14, ul: 1700, rda: 600 },
      { min_age: 14, max_age: 19, ul: 2800, rda: 900, sex: "male" },
      { min_age: 14, max_age: 19, ul: 2800, rda: 700, sex: "female" },
      { min_age: 19, max_age: null, ul: 3000, rda: 900, sex: "male" },
      { min_age: 19, max_age: null, ul: 3000, rda: 700, sex: "female" },
      { min_age: 14, max_age: null, ul: 3000, rda: 800 }, // sex-neutral fallback
    ],
  },
  {
    key: "vitamin_d",
    label: "Vitamin D",
    unit: "mcg",
    basis: "total",
    iu: 0.025, // 40 IU = 1 mcg
    note: "UL is total intake. 1 mcg = 40 IU.",
    bands: [
      { min_age: 1, max_age: 4, ul: 63, rda: 15 },
      { min_age: 4, max_age: 9, ul: 75, rda: 15 },
      { min_age: 9, max_age: 71, ul: 100, rda: 15 },
      { min_age: 71, max_age: null, ul: 100, rda: 20 },
    ],
  },
  {
    key: "vitamin_e",
    label: "Vitamin E",
    unit: "mg",
    basis: "supplemental",
    iu: 0.67, // 1 IU natural (d-alpha) = 0.67 mg; synthetic (dl-) = 0.45 mg
    note: "UL is for SUPPLEMENTAL alpha-tocopherol only (any form). IU forms assumed natural (0.67 mg/IU), which reads higher than synthetic (0.45 mg/IU) — the conservative choice for a UL warning.",
    bands: [
      { min_age: 1, max_age: 4, ul: 200, rda: 6 },
      { min_age: 4, max_age: 9, ul: 300, rda: 7 },
      { min_age: 9, max_age: 14, ul: 600, rda: 11 },
      { min_age: 14, max_age: 19, ul: 800, rda: 15 },
      { min_age: 19, max_age: null, ul: 1000, rda: 15 },
    ],
  },
  // ── Water-soluble vitamins ──────────────────────────────────────────────
  {
    key: "vitamin_c",
    label: "Vitamin C",
    unit: "mg",
    basis: "total",
    note: "UL is total intake.",
    bands: [
      { min_age: 1, max_age: 4, ul: 400, rda: 15 },
      { min_age: 4, max_age: 9, ul: 650, rda: 25 },
      { min_age: 9, max_age: 14, ul: 1200, rda: 45 },
      { min_age: 14, max_age: 19, ul: 1800, rda: 75, sex: "male" },
      { min_age: 14, max_age: 19, ul: 1800, rda: 65, sex: "female" },
      { min_age: 19, max_age: null, ul: 2000, rda: 90, sex: "male" },
      { min_age: 19, max_age: null, ul: 2000, rda: 75, sex: "female" },
      { min_age: 14, max_age: null, ul: 2000, rda: 85 }, // sex-neutral fallback
    ],
  },
  {
    key: "vitamin_b6",
    label: "Vitamin B6",
    unit: "mg",
    basis: "total",
    note: "UL is total intake.",
    bands: [
      { min_age: 1, max_age: 4, ul: 30, rda: 0.5 },
      { min_age: 4, max_age: 9, ul: 40, rda: 0.6 },
      { min_age: 9, max_age: 14, ul: 60, rda: 1 },
      { min_age: 14, max_age: 19, ul: 80, rda: 1.3 },
      { min_age: 19, max_age: null, ul: 100, rda: 1.3 },
    ],
  },
  {
    key: "niacin",
    label: "Niacin",
    unit: "mg",
    basis: "supplemental",
    note: "UL is for niacin from SUPPLEMENTS and fortified foods (nicotinic acid / niacinamide), not naturally-occurring niacin in food.",
    bands: [
      { min_age: 1, max_age: 4, ul: 10, rda: 6 },
      { min_age: 4, max_age: 9, ul: 15, rda: 8 },
      { min_age: 9, max_age: 14, ul: 20, rda: 12 },
      { min_age: 14, max_age: 19, ul: 30, rda: 16, sex: "male" },
      { min_age: 14, max_age: 19, ul: 30, rda: 14, sex: "female" },
      { min_age: 19, max_age: null, ul: 35, rda: 16, sex: "male" },
      { min_age: 19, max_age: null, ul: 35, rda: 14, sex: "female" },
      { min_age: 14, max_age: null, ul: 35, rda: 15 }, // sex-neutral fallback
    ],
  },
  {
    key: "folate",
    label: "Folate",
    unit: "mcg",
    basis: "supplemental",
    note: "UL is for folic acid from SUPPLEMENTS and fortified foods, not naturally-occurring food folate.",
    bands: [
      { min_age: 1, max_age: 4, ul: 300, rda: 150 },
      { min_age: 4, max_age: 9, ul: 400, rda: 200 },
      { min_age: 9, max_age: 14, ul: 600, rda: 300 },
      { min_age: 14, max_age: 19, ul: 800, rda: 400 },
      { min_age: 19, max_age: null, ul: 1000, rda: 400 },
    ],
  },
  // ── Minerals ────────────────────────────────────────────────────────────
  {
    key: "calcium",
    label: "Calcium",
    unit: "mg",
    basis: "total",
    note: "UL is total intake; it steps DOWN at 51 (2000 mg) from the 19–50 adult UL (2500 mg).",
    bands: [
      { min_age: 1, max_age: 9, ul: 2500, rda: 700 },
      { min_age: 9, max_age: 19, ul: 3000, rda: 1300 },
      { min_age: 19, max_age: 51, ul: 2500, rda: 1000 },
      { min_age: 51, max_age: null, ul: 2000, rda: 1200 },
    ],
  },
  {
    key: "magnesium",
    label: "Magnesium",
    unit: "mg",
    basis: "supplemental",
    note: "UL applies ONLY to supplemental magnesium (from products / pharmacologic agents), NOT to dietary magnesium from food and water. Values are elemental magnesium; product labels usually state the elemental amount.",
    bands: [
      { min_age: 1, max_age: 4, ul: 65, rda: 80 },
      { min_age: 4, max_age: 9, ul: 110, rda: 130 },
      { min_age: 9, max_age: 14, ul: 350, rda: 240 },
      { min_age: 14, max_age: 19, ul: 350, rda: 410, sex: "male" },
      { min_age: 14, max_age: 19, ul: 350, rda: 360, sex: "female" },
      { min_age: 19, max_age: null, ul: 350, rda: 420, sex: "male" },
      { min_age: 19, max_age: null, ul: 350, rda: 320, sex: "female" },
      { min_age: 9, max_age: null, ul: 350, rda: 400 }, // sex-neutral fallback
    ],
  },
  {
    key: "zinc",
    label: "Zinc",
    unit: "mg",
    basis: "total",
    note: "UL is total intake.",
    bands: [
      { min_age: 1, max_age: 4, ul: 7, rda: 3 },
      { min_age: 4, max_age: 9, ul: 12, rda: 5 },
      { min_age: 9, max_age: 14, ul: 23, rda: 8 },
      { min_age: 14, max_age: 19, ul: 34, rda: 11, sex: "male" },
      { min_age: 14, max_age: 19, ul: 34, rda: 9, sex: "female" },
      { min_age: 19, max_age: null, ul: 40, rda: 11, sex: "male" },
      { min_age: 19, max_age: null, ul: 40, rda: 8, sex: "female" },
      { min_age: 14, max_age: null, ul: 40, rda: 10 }, // sex-neutral fallback
    ],
  },
  {
    key: "iron",
    label: "Iron",
    unit: "mg",
    basis: "total",
    note: "UL is total intake. Adult RDA is strongly sex-specific (menstrual losses): 18 mg for women 19–50 vs 8 mg for men.",
    bands: [
      { min_age: 1, max_age: 4, ul: 40, rda: 7 },
      { min_age: 4, max_age: 9, ul: 40, rda: 10 },
      { min_age: 9, max_age: 14, ul: 40, rda: 8 },
      { min_age: 14, max_age: 19, ul: 45, rda: 11, sex: "male" },
      { min_age: 14, max_age: 19, ul: 45, rda: 15, sex: "female" },
      { min_age: 19, max_age: 51, ul: 45, rda: 8, sex: "male" },
      { min_age: 19, max_age: 51, ul: 45, rda: 18, sex: "female" },
      { min_age: 51, max_age: null, ul: 45, rda: 8 },
      { min_age: 14, max_age: 51, ul: 45, rda: 12 }, // sex-neutral fallback
    ],
  },
  {
    key: "selenium",
    label: "Selenium",
    unit: "mcg",
    basis: "total",
    note: "UL is total intake.",
    bands: [
      { min_age: 1, max_age: 4, ul: 90, rda: 20 },
      { min_age: 4, max_age: 9, ul: 150, rda: 30 },
      { min_age: 9, max_age: 14, ul: 280, rda: 40 },
      { min_age: 14, max_age: 19, ul: 400, rda: 55 },
      { min_age: 19, max_age: null, ul: 400, rda: 55 },
    ],
  },
  {
    key: "copper",
    label: "Copper",
    unit: "mcg",
    basis: "total",
    note: "UL is total intake. Canonical unit is mcg (UL 10000 mcg = 10 mg).",
    bands: [
      { min_age: 1, max_age: 4, ul: 1000, rda: 340 },
      { min_age: 4, max_age: 9, ul: 3000, rda: 440 },
      { min_age: 9, max_age: 14, ul: 5000, rda: 700 },
      { min_age: 14, max_age: 19, ul: 8000, rda: 890 },
      { min_age: 19, max_age: null, ul: 10000, rda: 900 },
    ],
  },
  {
    key: "manganese",
    label: "Manganese",
    unit: "mg",
    basis: "total",
    note: "UL is total intake; the adult reference intake is an AI, not an RDA.",
    bands: [
      { min_age: 1, max_age: 4, ul: 2, rda: 1.2 },
      { min_age: 4, max_age: 9, ul: 3, rda: 1.5 },
      { min_age: 9, max_age: 14, ul: 6, rda: 1.9 },
      { min_age: 14, max_age: 19, ul: 9, rda: 2.2 },
      { min_age: 19, max_age: null, ul: 11, rda: 2.3, sex: "male" },
      { min_age: 19, max_age: null, ul: 11, rda: 1.8, sex: "female" },
      { min_age: 19, max_age: null, ul: 11, rda: 2 }, // sex-neutral fallback
    ],
  },
  {
    key: "iodine",
    label: "Iodine",
    unit: "mcg",
    basis: "total",
    note: "UL is total intake.",
    bands: [
      { min_age: 1, max_age: 4, ul: 200, rda: 90 },
      { min_age: 4, max_age: 9, ul: 300, rda: 90 },
      { min_age: 9, max_age: 14, ul: 600, rda: 120 },
      { min_age: 14, max_age: 19, ul: 900, rda: 150 },
      { min_age: 19, max_age: null, ul: 1100, rda: 150 },
    ],
  },
  {
    key: "molybdenum",
    label: "Molybdenum",
    unit: "mcg",
    basis: "total",
    note: "UL is total intake.",
    bands: [
      { min_age: 1, max_age: 4, ul: 300, rda: 17 },
      { min_age: 4, max_age: 9, ul: 600, rda: 22 },
      { min_age: 9, max_age: 14, ul: 1100, rda: 34 },
      { min_age: 14, max_age: 19, ul: 1700, rda: 43 },
      { min_age: 19, max_age: null, ul: 2000, rda: 45 },
    ],
  },
  {
    key: "boron",
    label: "Boron",
    unit: "mg",
    basis: "total",
    note: "UL is total intake. Boron has no RDA (no established essential requirement).",
    bands: [
      { min_age: 1, max_age: 4, ul: 3, rda: null },
      { min_age: 4, max_age: 9, ul: 6, rda: null },
      { min_age: 9, max_age: 14, ul: 11, rda: null },
      { min_age: 14, max_age: 19, ul: 17, rda: null },
      { min_age: 19, max_age: null, ul: 20, rda: null },
    ],
  },
];

// The framework envelope shape: the NIH DRI table now ships as a curated-dataset
// envelope under lib/datasets/data/, identity-keyed by nutrient `key`. Age/sex bands
// live on the entries (each DriNutrient carries its own `bands`).
export type DriDataset = DatasetEnvelope<DriNutrient>;

// Pure builder: assemble the dataset from the curated table. The committed
// lib/datasets/data/dri.json is a FIXED POINT of this (guarded by the dataset test),
// so the generator and committed file can't silently diverge. Nutrients are emitted in
// curated order for a stable, reviewable diff.
export function buildDriDataset(): DriDataset {
  return {
    $schema: DATASET_SCHEMA,
    id: "dri",
    title: "NIH Dietary Reference Intakes (UL / RDA) by age and sex",
    description:
      "Baked NIH DRI dataset for supplement stack-total UL warnings (issue #148): " +
      "per-nutrient Tolerable Upper Intake Levels (ULs) + RDAs by age band and sex. " +
      "`basis` distinguishes supplemental-only ULs (magnesium, niacin, folic acid, " +
      "supplemental vitamin E) from total-intake ULs. Committed + HUMAN-REVIEWABLE. " +
      "Regenerate with `npm run gen:dri`. INFORMATIONAL reference values, NOT medical " +
      "advice or dosing guidance.",
    citation: [
      {
        source:
          "National Academies of Sciences, Engineering, and Medicine — Dietary " +
          "Reference Intakes (DRI) tables",
        url: "https://nap.nationalacademies.org/catalog/11537/dietary-reference-intakes-the-essential-guide-to-nutrient-requirements",
        note: "Public-domain UL/RDA values by life stage and sex.",
      },
      {
        source: "NIH Office of Dietary Supplements (ODS) nutrient fact sheets",
        url: "https://ods.od.nih.gov/factsheets/list-all/",
        note: "Cross-reference for supplemental-vs-total UL basis and IU conversion factors.",
      },
    ],
    identity: { keys: ["key"] },
    entries: NUTRIENTS,
  };
}

function writeDataset(): void {
  const dataset = buildDriDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.entries.length} nutrient DRI entries to ${OUT}`);
  console.log("Review the UL/RDA values for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildDriDataset).
if (process.argv[1]?.includes("gen-dri")) {
  writeDataset();
}
