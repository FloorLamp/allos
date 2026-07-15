// Pre-generate the baked contrast-safety cross-check dataset (lib/contrast-safety
// .json), used to flag when an ORDERED / PLANNED contrast imaging study (a
// care_plan_items row, a scheduled appointment, or a future-dated imaging_studies
// row, #702) meets a contrast/iodine/gadolinium ALLERGY or a renal contraindication
// (CKD) on file — the imaging twin of the drug–drug (gen-drug-interactions.ts) and
// pharmacogenomics (gen-pgx.ts) safety cross-checks (issue #701).
//
// SOURCING / LICENSE
// ------------------
// This is a small CURATED table, NOT an exhaustive contrast-media reference. The
// facts (which contrast CLASS a study uses, and which allergy / renal state warrants
// a pre-procedure conversation) are drawn from a PUBLIC clinical reference:
//
//   • ACR Manual on Contrast Media (American College of Radiology) — the freely
//     published standard reference on iodinated- and gadolinium-based contrast
//     safety (premedication for prior contrast reactions; contrast-induced
//     nephropathy / acute kidney injury risk in CKD for iodinated contrast; NSF
//     risk with older group-I gadolinium agents in advanced CKD). We DO NOT copy the
//     Manual's prose; we state the uncopyrightable clinical FACT (an allergy/renal
//     state on file is worth confirming with the provider) in our own words and CITE
//     the ACR Manual as the source.
//   • The contrast-agent generic/brand names (iohexol/Omnipaque, gadobutrol/Gadavist,
//     …) are public drug nomenclature.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. The app RELAYS the note as
// information with its source — it never blocks a study, never advises for or against
// it, and the ABSENCE of a flag is NOT clearance (this is a curated subset; a study
// the app can't parse, or a state not covered here, carries no flag). This is not a
// substitute for a radiologist's or ordering clinician's judgment.
//
// SENSITIVITY: fully OFFLINE — the curated table is baked here and shipped in the
// repo; no study text, allergy, or condition is ever sent to any external API.
//
// GENERATION
// ----------
// Mirrors gen-pgx.ts / gen-drug-interactions.ts: the curated constants below are the
// SOURCE OF TRUTH, the JSON is GENERATED from them and COMMITTED, and it is never
// hand-edited. Edit the tables below and re-run:
//
//   npm run gen:contrast-safety
//
// The committed lib/contrast-safety.json is a FIXED POINT of buildContrastDataset()
// (guarded by lib/__tests__/contrast-safety-dataset.test.ts) so the generator and the
// file can't silently diverge. lib/contrast-safety.json is in .prettierignore —
// prettier reformatting would break the fixed-point string compare.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "contrast-safety.json");

export type ContrastClass = "iodinated" | "gadolinium";
export type RenalLevel = "any" | "advanced";

// Normalize a keyword / synonym for storage + matching: lowercased, non-alphanumerics
// collapsed to single spaces, trimmed. The pure engine normalizes candidate text the
// SAME way and does a substring test, so "CT w/ contrast" and "ct with contrast"
// match one stored keyword. Exported for the dataset drift test.
export function normalizeKeyword(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function norm(list: string[]): string[] {
  return [...new Set(list.map(normalizeKeyword))].filter(Boolean).sort();
}

// The ACR Manual on Contrast Media — cited on every row.
const ACR = "ACR Manual on Contrast Media";

// ---- The two contrast classes -------------------------------------------------
// `modalities` are the imaging-modality words that IMPLY the class (CT/CTA →
// iodinated; MRI/MRA → gadolinium); `agents` are generic/brand contrast-agent names
// whose presence both confirms a contrast study and pins the class. EXCLUSION-
// DISCIPLINED: only the two contrast-bearing cross-sectional modalities are here —
// plain radiography, ultrasound, and DEXA carry no relevant contrast contraindication
// and get no class, so they never flag.
interface ClassDef {
  class: ContrastClass;
  label: string;
  modalities: string[];
  agents: string[];
}

const CLASSES: ClassDef[] = [
  {
    class: "iodinated",
    label: "iodinated contrast",
    // CT / CT angiography use iodinated contrast.
    modalities: ["ct", "cta", "ct angiography", "computed tomography"],
    agents: [
      "iodinated",
      "iodine",
      "iohexol",
      "omnipaque",
      "iodixanol",
      "visipaque",
      "iopamidol",
      "isovue",
      "ioversol",
      "optiray",
      "iopromide",
      "ultravist",
      "iobitridol",
    ],
  },
  {
    class: "gadolinium",
    label: "gadolinium contrast",
    // MRI / MR angiography use gadolinium-based contrast.
    modalities: ["mri", "mra", "magnetic resonance"],
    agents: [
      "gadolinium",
      "gbca",
      "gadobutrol",
      "gadavist",
      "gadoterate",
      "dotarem",
      "gadobenate",
      "multihance",
      "gadoteridol",
      "prohance",
      "gadoxetate",
      "eovist",
      "gadopentetate",
      "magnevist",
      "gadodiamide",
      "omniscan",
    ],
  },
];

// ---- Allergy gates ------------------------------------------------------------
// A recorded allergen (normalized) that CONTAINS one of these keywords, against a
// planned study of the matching class, warrants confirming premedication. The
// `note` copy is fixed by the issue's required framing.
interface AllergyGateDef {
  class: ContrastClass;
  allergens: string[];
  note: string;
  source: string;
}

const ALLERGY_GATES: AllergyGateDef[] = [
  {
    class: "iodinated",
    // The issue's explicit allergy gate: iodinated-contrast / iodine / contrast-dye.
    allergens: [
      "iodinated contrast",
      "iodinated",
      "iodine",
      "contrast dye",
      "contrast media",
      "contrast material",
      "radiocontrast",
      "ct contrast",
      "iv contrast",
    ],
    note: "You have an iodinated-contrast allergy on file — confirm premedication with your provider.",
    source: ACR,
  },
  {
    class: "gadolinium",
    allergens: [
      "gadolinium",
      "gadolinium contrast",
      "gadolinium based contrast",
      "gbca",
      "mri contrast",
    ],
    note: "You have a gadolinium-contrast allergy on file — confirm premedication with your provider.",
    source: ACR,
  },
];

// ---- Renal gates --------------------------------------------------------------
// A CKD state on file, against a planned study of the matching class. `level: "any"`
// = any recognized CKD (the iodinated → contrast-induced-nephropathy gate); `level:
// "advanced"` = advanced/ESRD/dialysis/stage-4-5 CKD (the gadolinium → NSF gate,
// which is a concern only for the older group-I agents in advanced kidney disease).
interface RenalGateDef {
  class: ContrastClass;
  level: RenalLevel;
  note: string;
  source: string;
}

const RENAL_GATES: RenalGateDef[] = [
  {
    class: "iodinated",
    level: "any",
    note: "CKD on file — discuss contrast nephropathy risk / hydration with your provider.",
    source: ACR,
  },
  {
    class: "gadolinium",
    level: "advanced",
    note: "Advanced CKD on file — discuss NSF risk with older gadolinium agents and hydration with your provider.",
    source: ACR,
  },
];

export function buildContrastDataset() {
  const classes = CLASSES.map((c) => ({
    class: c.class,
    label: c.label,
    modalities: norm(c.modalities),
    agents: norm(c.agents),
  })).sort((a, b) => a.class.localeCompare(b.class));

  const allergyGates = ALLERGY_GATES.map((g) => ({
    class: g.class,
    allergens: norm(g.allergens),
    note: g.note,
    source: g.source,
  })).sort((a, b) => a.class.localeCompare(b.class));

  const renalGates = RENAL_GATES.map((g) => ({
    class: g.class,
    level: g.level,
    note: g.note,
    source: g.source,
  })).sort(
    (a, b) => a.class.localeCompare(b.class) || a.level.localeCompare(b.level)
  );

  return {
    $comment:
      "Baked contrast-safety cross-check dataset (issue #701) — flags when an " +
      "ORDERED/PLANNED contrast imaging study (a care_plan_items row, a scheduled " +
      "appointment, or a future-dated imaging_studies row, #702) meets a contrast/ " +
      "iodine/gadolinium ALLERGY or a renal (CKD) contraindication on file. CURATED " +
      "table from the ACR Manual on Contrast Media (facts stated in our own words, " +
      "CITED to the ACR); the agent names are public drug nomenclature. " +
      "INFORMATIONAL, never prescriptive — it never blocks a study, never advises " +
      "for/against it, and the absence of a flag is NOT clearance. Fully OFFLINE. " +
      "Committed + HUMAN-REVIEWABLE; regenerate with `npm run gen:contrast-safety`.",
    version: 1,
    classes,
    allergyGates,
    renalGates,
  };
}

function writeDataset(): void {
  const dataset = buildContrastDataset();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.classes.length} classes, ${dataset.allergyGates.length} allergy gates, ${dataset.renalGates.length} renal gates to ${OUT}`
  );
  console.log("Review the table for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildContrastDataset).
if (process.argv[1]?.includes("gen-contrast-safety")) {
  writeDataset();
}
