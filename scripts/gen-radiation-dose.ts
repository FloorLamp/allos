// Pre-generate the baked typical-radiation-dose dataset
// (lib/datasets/data/radiation-dose.json), used as a FALLBACK effective-dose estimate
// for an imaging study that carries no recorded `dose_msv` (issue #703) — the imaging
// twin of the MET (gen-mets.ts) / DRI (gen-dri.ts) reference tables the issue names as
// the precedent style, loaded onto the curated-dataset framework (#860).
//
// WHAT THIS IS: a small, CURATED table of TYPICAL adult effective doses (millisieverts,
// mSv) by imaging exam. Effective dose is population-averaged and varies widely with
// scanner, protocol, and body habitus, so every value here is an ORDER-OF-MAGNITUDE
// TYPICAL figure, NEVER a measurement of any individual scan. It exists so the Imaging
// section can show a calm, clearly-labeled ESTIMATE when a report doesn't print a dose
// (most consumer radiology reports don't) — separate from, never summed into, a
// recorded dose.
//
// SOURCING / LICENSE: the effective-dose figures are uncopyrightable clinical facts,
// stated as rounded typical values and CITED to their public sources — the Mettler et
// al. catalog (Radiology 2008), RadiologyInfo.org (ACR/RSNA patient reference), and
// NCRP/UNSCEAR for the natural-background comparator. A small curated subset, NOT
// exhaustive; an exam not in the table carries no estimate (the refusal gate — never a
// guess).
//
// NON-IONIZING modalities (MRI, ultrasound) use NO ionizing radiation and carry a dose
// of 0 by physics, not by estimate. The `other` modality is deliberately absent — a
// genuinely unclassified study can't be responsibly estimated, so it contributes
// nothing to the running total rather than a fabricated number. The CLASSIFIABLE
// high-dose modalities — PET, nuclear medicine, fluoroscopy — carry their own entries
// (#1034): before they existed on the enum they fell into that refusal bucket and the
// cumulative total silently understated for exactly the patients getting the most
// radiation.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER ALARMIST. The running total is a
// quantified-self signal, not a verdict — there is no "you've had too much" line; dose
// is a conversation to have with a provider.
//
// GENERATION: mirrors gen-ototoxic.ts — the curated constants below are the SOURCE OF
// TRUTH, the JSON is GENERATED from them and COMMITTED, and is never hand-edited. Edit
// the table below and re-run:
//
//   npm run gen:radiation-dose
//
// The committed lib/datasets/data/radiation-dose.json is a FIXED POINT of
// buildRadiationDoseDataset() (guarded by lib/__tests__/radiation-dose-dataset.test.ts)
// so the generator and the file can't silently diverge. Emitted with
// `JSON.stringify(dataset, null, 2)`, matching Prettier's JSON formatting.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";
import type { ImagingModality } from "../lib/types/medical";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "radiation-dose.json"
);

// One framework entry: a typical effective dose for an imaging exam. `modality` is our
// enum; `regions` are lowercased body-region MATCH TOKENS (substring-matched against a
// study's free-text body_region) — an entry with EMPTY `regions` is that modality's
// GENERIC fallback, used when no region-specific entry matches. `msv` is the typical
// adult effective dose in millisieverts. Identity is the `key` slug.
export interface RadiationDoseEntry {
  key: string;
  modality: ImagingModality;
  regions: string[];
  msv: number;
  label: string;
  source: string;
}

// Dataset-level metadata that ISN'T a per-exam entry: the schema version and the
// natural-background comparator (US average annual effective dose from natural
// sources) — used ONLY to phrase the running total in calm, relatable terms ("about
// the same as N months of natural background radiation"), never as a threshold.
export interface RadiationDoseMeta {
  version: number;
  naturalBackgroundMsvPerYear: number;
  naturalBackgroundSource: string;
}

export type RadiationDoseDataset = DatasetEnvelope<
  RadiationDoseEntry,
  RadiationDoseMeta
>;

const METTLER = "Mettler et al., Radiology 2008 (effective-dose catalog)";
const RADIOLOGYINFO = "RadiologyInfo.org (ACR/RSNA patient reference)";

// The curated table. Rounded, typical adult effective doses — order-of-magnitude
// figures, not measurements. Region-specific entries come first; each modality that
// can be ionizing carries a generic (empty-regions) fallback.
const ENTRIES: RadiationDoseEntry[] = [
  // ── Plain radiography (X-ray) ──────────────────────────────────────────────
  {
    key: "xray-chest",
    modality: "x-ray",
    regions: ["chest", "thorax", "lung", "rib"],
    msv: 0.1,
    label: "Chest X-ray",
    source: RADIOLOGYINFO,
  },
  {
    key: "xray-extremity",
    modality: "x-ray",
    regions: [
      "knee",
      "hand",
      "wrist",
      "foot",
      "ankle",
      "elbow",
      "shoulder",
      "arm",
      "leg",
      "finger",
      "toe",
      "extremity",
      "limb",
    ],
    msv: 0.001,
    label: "Extremity X-ray",
    source: METTLER,
  },
  {
    key: "xray-spine",
    modality: "x-ray",
    regions: ["spine", "lumbar", "cervical", "thoracic", "back"],
    msv: 1.5,
    label: "Spine X-ray",
    source: METTLER,
  },
  {
    key: "xray-abdomen",
    modality: "x-ray",
    regions: ["abdomen", "kub", "pelvis", "hip"],
    msv: 0.7,
    label: "Abdominal X-ray",
    source: RADIOLOGYINFO,
  },
  {
    key: "xray-mammography",
    modality: "x-ray",
    regions: ["breast", "mammogram", "mammograph", "mammo"],
    msv: 0.4,
    label: "Mammography",
    source: RADIOLOGYINFO,
  },
  {
    key: "xray-dental",
    modality: "x-ray",
    regions: ["dental", "tooth", "teeth", "bitewing", "panoramic"],
    msv: 0.005,
    label: "Dental X-ray",
    source: RADIOLOGYINFO,
  },
  {
    key: "xray-generic",
    modality: "x-ray",
    regions: [],
    msv: 0.1,
    label: "X-ray",
    source: RADIOLOGYINFO,
  },
  // ── Computed tomography (CT) ───────────────────────────────────────────────
  {
    key: "ct-head",
    modality: "ct",
    regions: ["head", "brain", "skull"],
    msv: 2,
    label: "CT head",
    source: RADIOLOGYINFO,
  },
  {
    key: "ct-chest",
    modality: "ct",
    regions: ["chest", "thorax", "lung", "pulmonary"],
    msv: 7,
    label: "CT chest",
    source: RADIOLOGYINFO,
  },
  {
    key: "ct-abdomen-pelvis",
    modality: "ct",
    regions: ["abdomen", "pelvis", "abdominal"],
    msv: 10,
    label: "CT abdomen/pelvis",
    source: RADIOLOGYINFO,
  },
  {
    key: "ct-spine",
    modality: "ct",
    regions: ["spine", "lumbar", "cervical", "thoracic"],
    msv: 6,
    label: "CT spine",
    source: METTLER,
  },
  {
    key: "ct-cardiac",
    modality: "ct",
    regions: ["cardiac", "heart", "coronary", "calcium score"],
    msv: 3,
    label: "Cardiac CT / calcium score",
    source: METTLER,
  },
  {
    key: "ct-generic",
    modality: "ct",
    regions: [],
    msv: 7,
    label: "CT",
    source: METTLER,
  },
  // ── DEXA (bone densitometry) — ionizing but very low ───────────────────────
  {
    key: "dexa",
    modality: "dexa",
    regions: [],
    msv: 0.001,
    label: "DEXA bone density",
    source: METTLER,
  },
  // ── PET (positron emission tomography, incl. hybrid PET/CT) (#1034) ────────
  // A whole-body FDG PET/CT — the overwhelmingly common exam — runs ~25 mSv
  // (tracer ~14 + the co-acquired CT), per the Mettler catalog / RadiologyInfo.
  // One generic entry: whole-body IS the typical study, so it doubles as the
  // modality fallback.
  {
    key: "pet-wholebody",
    modality: "pet",
    regions: [],
    msv: 25,
    label: "PET/CT (FDG, whole body)",
    source: METTLER,
  },
  // ── Nuclear medicine (SPECT / scintigraphy) (#1034) ────────────────────────
  // Study-dependent: the tracer sets the dose. Region-specific entries where the
  // Mettler catalog supports them, plus a generic mid-range fallback so an
  // unspecified nuclear study still estimates instead of contributing 0.
  {
    key: "nm-cardiac-perfusion",
    modality: "nuclear-medicine",
    regions: ["cardiac", "heart", "myocardial", "coronary"],
    msv: 12,
    label: "Cardiac SPECT (myocardial perfusion)",
    source: METTLER,
  },
  {
    key: "nm-bone-scan",
    modality: "nuclear-medicine",
    regions: ["bone", "skeletal", "whole body"],
    msv: 6,
    label: "Bone scan (Tc-99m)",
    source: METTLER,
  },
  {
    key: "nm-lung-vq",
    modality: "nuclear-medicine",
    regions: ["lung", "pulmonary", "chest"],
    msv: 2,
    label: "Lung ventilation/perfusion (V/Q) scan",
    source: METTLER,
  },
  {
    key: "nm-hepatobiliary",
    modality: "nuclear-medicine",
    regions: ["hepatobiliary", "gallbladder", "biliary", "liver"],
    msv: 3,
    label: "Hepatobiliary (HIDA) scan",
    source: METTLER,
  },
  {
    key: "nm-thyroid",
    modality: "nuclear-medicine",
    regions: ["thyroid", "neck"],
    msv: 2,
    label: "Thyroid scan/uptake",
    source: METTLER,
  },
  {
    key: "nm-generic",
    modality: "nuclear-medicine",
    regions: [],
    msv: 5,
    label: "Nuclear medicine study",
    source: METTLER,
  },
  // ── Fluoroscopy (incl. interventional angiography) (#1034) ─────────────────
  // Procedure-dependent: diagnostic contrast exams run mid-single-digit mSv;
  // interventional work spans roughly 10–100 mSv. The generic fallback sits at
  // the low end of the interventional band — still an order-of-magnitude typical
  // figure, never a measurement.
  {
    key: "fluoro-coronary-angio",
    modality: "fluoroscopy",
    regions: ["coronary", "cardiac", "heart"],
    msv: 7,
    label: "Coronary angiography (diagnostic)",
    source: METTLER,
  },
  {
    key: "fluoro-upper-gi",
    modality: "fluoroscopy",
    regions: ["upper gi", "esophag", "swallow", "stomach"],
    msv: 6,
    label: "Upper GI series (barium)",
    source: METTLER,
  },
  {
    key: "fluoro-barium-enema",
    modality: "fluoroscopy",
    regions: ["enema", "colon", "lower gi"],
    msv: 8,
    label: "Barium enema (lower GI)",
    source: METTLER,
  },
  {
    key: "fluoro-vcug",
    modality: "fluoroscopy",
    regions: ["vcug", "cystourethro", "bladder", "urethra"],
    msv: 1.5,
    label: "Voiding cystourethrogram (VCUG)",
    source: METTLER,
  },
  {
    key: "fluoro-generic",
    modality: "fluoroscopy",
    regions: [],
    msv: 10,
    label: "Fluoroscopy / interventional procedure",
    source: METTLER,
  },
  // ── Non-ionizing modalities — dose 0 by physics, not estimate ──────────────
  {
    key: "mri",
    modality: "mri",
    regions: [],
    msv: 0,
    label: "MRI (no ionizing radiation)",
    source: RADIOLOGYINFO,
  },
  {
    key: "ultrasound",
    modality: "ultrasound",
    regions: [],
    msv: 0,
    label: "Ultrasound (no ionizing radiation)",
    source: RADIOLOGYINFO,
  },
];

export function buildRadiationDoseDataset(): RadiationDoseDataset {
  const entries: RadiationDoseEntry[] = ENTRIES.map((e) => ({
    key: e.key,
    modality: e.modality,
    regions: [...new Set(e.regions.map((r) => r.toLowerCase().trim()))]
      .filter(Boolean)
      .sort(),
    msv: e.msv,
    label: e.label,
    source: e.source,
  })).sort((a, b) => a.key.localeCompare(b.key));

  return {
    $schema: DATASET_SCHEMA,
    id: "radiation-dose",
    title: "Typical radiation dose by imaging exam",
    description:
      "Baked typical-radiation-dose dataset (issue #703) — a FALLBACK effective-dose " +
      "ESTIMATE (millisieverts, mSv) for an imaging study that carries no recorded " +
      "dose, so the Imaging section can show a calm, clearly-labeled running total. " +
      "Values are rounded, population-averaged TYPICAL adult figures (order of " +
      "magnitude, never a measurement of an individual scan), CITED to public " +
      "references. MRI / ultrasound are 0 (non-ionizing); an unclassified 'other' " +
      "study has no entry and is never estimated. INFORMATIONAL, never alarmist — dose " +
      "is a provider conversation, not a verdict. Fully OFFLINE. Committed + " +
      "HUMAN-REVIEWABLE; regenerate with `npm run gen:radiation-dose`.",
    citation: [
      {
        source: METTLER,
        url: "https://pubs.rsna.org/doi/10.1148/radiol.2481071451",
        note: "Mettler FA et al. 'Effective doses in radiology and diagnostic nuclear medicine: a catalog.' Radiology 2008;248(1):254-263. Rounded typical effective-dose facts stated in our own words.",
      },
      {
        source: RADIOLOGYINFO,
        url: "https://www.radiologyinfo.org/en/info/safety-xray",
        note: "ACR/RSNA patient-facing 'Radiation Dose in X-Ray and CT Examinations' reference. Uncopyrightable typical-dose facts stated in our own words.",
      },
    ],
    identity: { keys: ["key"] },
    meta: {
      version: 2,
      naturalBackgroundMsvPerYear: 3,
      naturalBackgroundSource:
        "NCRP Report No. 160 / UNSCEAR — US average annual effective dose from natural background (~3 mSv/yr)",
    },
    entries,
  };
}

function writeDataset(): void {
  const dataset = buildRadiationDoseDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} radiation-dose entries to ${OUT}`
  );
  console.log("Review the table for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildRadiationDoseDataset).
if (process.argv[1]?.includes("gen-radiation-dose")) {
  writeDataset();
}
