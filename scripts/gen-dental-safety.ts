// Pre-generate the baked dental-procedure safety cross-check dataset
// (lib/datasets/data/dental-safety.json), used to surface a calm, informational
// pre-procedure note when an INVASIVE dental procedure is PLANNED (a status='planned'
// dental_procedures row that is bone-manipulating / bleeding-prone, #705) and the
// active stack / conditions carry a well-established, high-consequence interaction
// (issue #704) — the dental twin of the contrast (gen-contrast-safety.ts), drug–drug
// (gen-drug-interactions.ts), and pharmacogenomics (gen-pgx.ts) safety cross-checks.
//
// The three curated, CITED tables:
//   • ANTIRESORPTIVE → MRONJ: a bisphosphonate or denosumab on file, facing an
//     extraction / implant / bony surgery, warrants a medication-related-
//     osteonecrosis-of-the-jaw conversation (AAOMS position paper). Drugs matched by
//     RxNorm ingredient CUI + synonym through the shared matchConceptKeysIn machinery
//     (#482 identity), NOT raw-name matching.
//   • CARDIAC → ANTIBIOTIC PROPHYLAXIS: a high-risk cardiac condition (prosthetic
//     valve, prior infective endocarditis, certain congenital heart disease, cardiac
//     transplant with valvulopathy) may warrant antibiotic prophylaxis before invasive
//     dental work (AHA/ACC guideline). Conditions matched by curated keyword.
//   • ANTICOAGULANT → BLEEDING: warfarin or a DOAC on file warrants a bleeding-
//     management conversation before an extraction / oral surgery (ADA/ACC).
//
// SOURCING / LICENSE: small CURATED tables, NOT exhaustive references. The
// uncopyrightable clinical FACTS are stated in our own words and CITED to their public
// guideline; drug generic/brand names and RxCUIs are public nomenclature.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A note flags a conversation to
// have with the dentist / prescriber — it never says "stop your drug" / "you need
// antibiotics", never blocks a procedure, and the ABSENCE of a flag is NOT clearance
// (a curated subset; a routine cleaning, or a state not covered here, carries no flag).
//
// SENSITIVITY: fully OFFLINE — the curated tables are baked here and shipped in the
// repo; no procedure, medication, or condition is ever sent to any external API.
//
// GENERATION: mirrors gen-contrast-safety.ts — the curated constants below are the
// SOURCE OF TRUTH, the JSON is GENERATED from them and COMMITTED, and is never
// hand-edited. Edit the tables below and re-run:
//
//   npm run gen:dental-safety
//
// The committed lib/datasets/data/dental-safety.json is a FIXED POINT of
// buildDentalSafetyDataset() (guarded by lib/__tests__/dental-safety-dataset.test.ts)
// so the generator and the file can't silently diverge. Emitted with
// `JSON.stringify(dataset, null, 2)`, matching Prettier's JSON formatting.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "dental-safety.json"
);

export type DentalDrugCategory = "antiresorptive" | "anticoagulant";

// One framework entry: a DRUG concept the cross-check detects in the active stack,
// matched by RxNorm ingredient CUI + synonym (the shared matchConceptKeysIn machinery,
// #482). Structurally a superset of drug-interactions' `Concept` ({key,label,rxcuis,
// synonyms}) so it feeds that matcher directly; `category` picks which invasive-dental
// caution it raises and `note`/`source` are the finding copy.
export interface DentalDrugEntry {
  key: string;
  category: DentalDrugCategory;
  label: string;
  rxcuis: string[];
  synonyms: string[];
  note: string;
  source: string;
}

// A cardiac-condition gate for antibiotic prophylaxis: an active condition whose
// normalized text CONTAINS one of `keywords` warrants the note against an invasive
// dental procedure. Keyword-matched (there is no coded cardiac-risk recognizer).
export interface DentalConditionGate {
  key: string;
  label: string;
  keywords: string[];
  note: string;
  source: string;
}

// Dataset-level metadata that ISN'T a per-drug entry: the schema version and the
// cardiac condition-gate table.
export interface DentalSafetyMeta {
  version: number;
  conditionGates: DentalConditionGate[];
}

export type DentalSafetyDataset = DatasetEnvelope<
  DentalDrugEntry,
  DentalSafetyMeta
>;

// Normalize a keyword / synonym for storage + matching: lowercased, non-alphanumerics
// collapsed to single spaces, trimmed. The pure engine normalizes candidate condition
// text the SAME way and does a token-aware test.
export function normalizeKeyword(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function norm(list: string[]): string[] {
  return [...new Set(list.map(normalizeKeyword))].filter(Boolean).sort();
}

const AAOMS =
  "AAOMS Position Paper on Medication-Related Osteonecrosis of the Jaw (2022)";
const AHA =
  "AHA/ACC Guideline on Prevention of Infective Endocarditis (2007, reaffirmed)";
const ADA_ACC = "American Dental Association; ACC/AHA anticoagulation guidance";

// ---- Drug entries (antiresorptive → MRONJ; anticoagulant → bleeding) ----------
// RxCUIs are RxNorm ingredient concept ids reused from the committed datasets where
// present (warfarin 11289; the DOAC ingredients from drug-interactions.json). The
// antiresorptives lean on synonyms (the same approach the food-bisphosphonate concept
// takes) — a synonym match is sufficient and precise for these named drugs.
const DRUGS: DentalDrugEntry[] = [
  {
    key: "antiresorptive_bisphosphonate",
    category: "antiresorptive",
    label: "Bisphosphonates (alendronate, risedronate, zoledronate)",
    rxcuis: [],
    synonyms: [
      "alendronate",
      "fosamax",
      "binosto",
      "risedronate",
      "actonel",
      "atelvia",
      "ibandronate",
      "boniva",
      "zoledronic acid",
      "zoledronate",
      "reclast",
      "zometa",
      "pamidronate",
      "aredia",
      "etidronate",
      "tiludronate",
      "bisphosphonate",
    ],
    note: "You take a bisphosphonate — discuss the (small) risk of medication-related osteonecrosis of the jaw (MRONJ) with your dentist before an extraction, implant, or other bony surgery.",
    source: AAOMS,
  },
  {
    key: "antiresorptive_denosumab",
    category: "antiresorptive",
    label: "Denosumab (Prolia, Xgeva)",
    rxcuis: [],
    synonyms: ["denosumab", "prolia", "xgeva"],
    note: "You take denosumab, an antiresorptive — discuss the risk of medication-related osteonecrosis of the jaw (MRONJ) with your dentist before an extraction, implant, or other bony surgery.",
    source: AAOMS,
  },
  {
    key: "anticoagulant_warfarin",
    category: "anticoagulant",
    label: "Warfarin",
    rxcuis: ["11289"],
    synonyms: ["warfarin", "coumadin", "jantoven"],
    note: "You take warfarin — discuss bleeding management (and whether your INR should be checked) with your dentist and prescriber before an extraction or oral surgery.",
    source: ADA_ACC,
  },
  {
    key: "anticoagulant_doac",
    category: "anticoagulant",
    label: "Direct oral anticoagulants (apixaban, rivaroxaban, dabigatran)",
    rxcuis: ["1364430", "1114195", "1037045"],
    synonyms: [
      "apixaban",
      "eliquis",
      "rivaroxaban",
      "xarelto",
      "dabigatran",
      "pradaxa",
      "edoxaban",
      "savaysa",
    ],
    note: "You take a direct oral anticoagulant — discuss bleeding management (such as dose timing) with your dentist and prescriber before an extraction or oral surgery.",
    source: ADA_ACC,
  },
];

// ---- Cardiac condition gates (→ antibiotic prophylaxis) -----------------------
// The AHA high-risk cardiac conditions for which antibiotic prophylaxis is reasonable
// before dental procedures that manipulate gingival tissue / the periapical region.
// EXCLUSION-DISCIPLINED: only the AHA high-risk set is here — ordinary CAD, a stent, a
// pacemaker, hypertension, or a murmur are NOT on the list and get no flag.
const CONDITION_GATES: DentalConditionGate[] = [
  {
    key: "prosthetic_valve",
    label: "Prosthetic heart valve",
    keywords: [
      "prosthetic valve",
      "prosthetic heart valve",
      "mechanical valve",
      "mechanical heart valve",
      "bioprosthetic valve",
      "prosthetic aortic valve",
      "prosthetic mitral valve",
      "valve replacement",
      "aortic valve replacement",
      "mitral valve replacement",
      "tavr",
      "tavi",
      "prosthetic valve material",
    ],
    note: "Prosthetic heart valve on file — antibiotic prophylaxis may be indicated before invasive dental work (AHA). Discuss with your dentist and cardiologist.",
    source: AHA,
  },
  {
    key: "prior_endocarditis",
    label: "Previous infective endocarditis",
    keywords: [
      "infective endocarditis",
      "bacterial endocarditis",
      "endocarditis",
    ],
    note: "Previous infective endocarditis on file — antibiotic prophylaxis may be indicated before invasive dental work (AHA). Discuss with your dentist and cardiologist.",
    source: AHA,
  },
  {
    key: "congenital_heart_disease",
    label: "Certain congenital heart disease",
    keywords: [
      "cyanotic congenital heart",
      "unrepaired congenital heart",
      "congenital heart defect",
      "congenital heart disease",
      "tetralogy of fallot",
      "single ventricle",
      "transposition of the great arteries",
    ],
    note: "Congenital heart disease on file — for the AHA high-risk categories, antibiotic prophylaxis may be indicated before invasive dental work. Discuss with your dentist and cardiologist.",
    source: AHA,
  },
  {
    key: "cardiac_transplant_valvulopathy",
    label: "Cardiac transplant with valvulopathy",
    keywords: ["cardiac transplant", "heart transplant"],
    note: "Heart transplant on file — if there is transplant-related valve disease (valvulopathy), antibiotic prophylaxis may be indicated before invasive dental work (AHA). Discuss with your dentist and cardiologist.",
    source: AHA,
  },
];

export function buildDentalSafetyDataset(): DentalSafetyDataset {
  const drugs: DentalDrugEntry[] = DRUGS.map((d) => ({
    key: d.key,
    category: d.category,
    label: d.label,
    rxcuis: [...new Set(d.rxcuis)].sort(),
    synonyms: norm(d.synonyms),
    note: d.note,
    source: d.source,
  })).sort((a, b) => a.key.localeCompare(b.key));

  const conditionGates: DentalConditionGate[] = CONDITION_GATES.map((g) => ({
    key: g.key,
    label: g.label,
    keywords: norm(g.keywords),
    note: g.note,
    source: g.source,
  })).sort((a, b) => a.key.localeCompare(b.key));

  return {
    $schema: DATASET_SCHEMA,
    id: "dental-safety",
    title: "Dental-procedure safety cross-check",
    description:
      "Baked dental-procedure safety cross-check dataset (issue #704) — flags when an " +
      "INVASIVE dental procedure is PLANNED (a bone-manipulating / bleeding-prone " +
      "status='planned' dental_procedures row, #705) and the active stack / conditions " +
      "carry a high-consequence interaction: an ANTIRESORPTIVE (bisphosphonate / " +
      "denosumab) → MRONJ caution, a high-risk CARDIAC condition → antibiotic-" +
      "prophylaxis note (AHA), or an ANTICOAGULANT → bleeding-management note. Drugs " +
      "match by RxNorm ingredient CUI + synonym (the shared machinery); conditions by " +
      "curated keyword. INFORMATIONAL, never prescriptive — it never says stop a drug " +
      "or take an antibiotic, never blocks a procedure, and the absence of a flag is " +
      "NOT clearance. A routine cleaning is non-invasive and triggers nothing. Fully " +
      "OFFLINE. Committed + HUMAN-REVIEWABLE; regenerate with `npm run gen:dental-safety`.",
    citation: [
      {
        source: AAOMS,
        url: "https://www.aaoms.org/practice-resources/aaoms-position-papers",
        note: "Uncopyrightable clinical facts (antiresorptive → MRONJ risk for invasive dental procedures) stated in our own words and cited to the AAOMS position paper.",
      },
      {
        source: AHA,
        url: "https://www.ahajournals.org/doi/10.1161/CIRCULATIONAHA.106.183095",
        note: "The AHA high-risk cardiac condition set for infective-endocarditis prophylaxis before dental procedures, stated in our own words and cited to the AHA guideline.",
      },
      {
        source: ADA_ACC,
        url: "https://www.ada.org/resources/ada-library/oral-health-topics/oral-anticoagulant-and-antiplatelet-drugs",
        note: "The anticoagulant → bleeding-management consideration for dental extractions, stated in our own words. Drug generic/brand names and RxCUIs are public nomenclature.",
      },
    ],
    identity: { keys: ["key"] },
    meta: {
      version: 1,
      conditionGates,
    },
    entries: drugs,
  };
}

function writeDataset(): void {
  const dataset = buildDentalSafetyDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} drug entries, ${dataset.meta!.conditionGates.length} condition gates to ${OUT}`
  );
  console.log("Review the tables for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildDentalSafetyDataset).
if (process.argv[1]?.includes("gen-dental-safety")) {
  writeDataset();
}
