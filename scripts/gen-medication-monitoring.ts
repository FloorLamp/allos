// Pre-generate the baked medication-monitoring dataset
// (lib/datasets/data/medication-monitoring.json) — the curated bridge between an ACTIVE
// medication and the periodic labs a clinician typically monitors while it is taken
// (issue #995). The med→required-monitoring-lab bridge: several drugs require ongoing
// lab surveillance (lithium → serum level + TSH + renal; clozapine → ANC; warfarin →
// INR; …), and this table is the per-drug data a builder turns into a retest clock.
//
// This is the DATA layer only — the hearing twin of gen-ototoxic.ts / gen-pgx.ts: the
// curated constants below are the SOURCE OF TRUTH, the JSON is GENERATED from them and
// COMMITTED, never hand-edited. Drugs match by RxNorm ingredient CUI + synonym through
// the shared matchConceptKeysIn machinery (#482), exactly like the ototoxic cross-check;
// rxcuis are left empty here (synonym-matched) to stay fully OFFLINE.
//
// Each entry carries the REQUIRED monitoring labs (by CANONICAL biomarker name — the
// #482 identity discipline, so satisfaction can go through biomarkerFamily and an eAG
// reading satisfies an HbA1c requirement), a baseline-needed flag, an INIT cadence
// (tighter right after starting / a dose change) and a MAINTENANCE cadence (steady
// state), a per-entry reach TIER (#449 — care pushes, coaching is calm), an
// informational note, and a citation.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE (issue #995 decision 3): the copy
// says "your clinician typically monitors X on this medication" / "discuss timing", never
// "get this test". The curated table is a small, well-established subset, NOT exhaustive;
// the absence of an entry is NOT clearance (an uncatalogued med simply produces no
// retest). Fully OFFLINE — no medication name is ever sent anywhere.
//
// GENERATION: mirrors gen-ototoxic.ts. Edit the table below and re-run:
//
//   npm run gen:medication-monitoring
//
// The committed lib/datasets/data/medication-monitoring.json is a FIXED POINT of
// buildMedMonitoringDataset() (guarded by lib/__tests__/medication-monitoring-dataset.test.ts)
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
  "medication-monitoring.json"
);

// The reach tier a monitored drug's retest clock travels (#449 / #995 decision 1). CARE
// pushes (the Telegram digest highlight, the Needs-attention hero) and ranks up; COACHING
// is calm — surfaced on Upcoming + the medications row note, never a push, never the hero.
export type MonitoringTier = "care" | "coaching";

// One required monitoring lab. `canonical` is the CANONICAL biomarker name the
// satisfaction check keys on (#482 — matched family-aware, so an eAG reading satisfies an
// "Hemoglobin A1c" requirement); `label` is the short human phrase the retest item / row
// note renders ("lithium level", "TSH", "kidney function").
export interface MonitoringLab {
  canonical: string;
  label: string;
}

// One framework entry: a DRUG (or drug class) whose active use warrants periodic lab
// monitoring. Matched by RxNorm ingredient CUI + synonym (the shared matchConceptKeysIn
// machinery, #482) — structurally a superset of drug-interactions' `Concept` ({key,label,
// rxcuis,synonyms}) so it feeds that matcher directly. `labs` are the required monitors;
// `baseline` flags that labs are recommended at/before start; `initDays`/`maintenanceDays`
// are the tighter-then-steady cadences; `tier` is the reach; `note`/`source` are copy.
export interface MedMonitoringEntry {
  key: string;
  label: string;
  rxcuis: string[];
  synonyms: string[];
  labs: MonitoringLab[];
  baseline: boolean;
  initDays: number;
  maintenanceDays: number;
  tier: MonitoringTier;
  note: string;
  source: string;
}

// Dataset-level metadata that ISN'T a per-drug entry: the schema version.
export interface MedMonitoringMeta {
  version: number;
}

export type MedMonitoringDataset = DatasetEnvelope<
  MedMonitoringEntry,
  MedMonitoringMeta
>;

// Normalize a synonym for storage + matching: lowercased, non-alphanumerics collapsed to
// single spaces, trimmed — the SAME normalization the drug-interaction matcher uses.
export function normalizeSynonym(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function norm(list: string[]): string[] {
  return [...new Set(list.map(normalizeSynonym))].filter(Boolean).sort();
}

// Citations. Uncopyrightable clinical facts (this drug is monitored with these labs) are
// stated in our own words and cited to their public source; drug generic/brand names are
// public nomenclature.
const FDA_CLOZAPINE =
  "FDA Clozapine REMS — Absolute Neutrophil Count (ANC) monitoring";
const ACC_AHA_WARFARIN =
  "ACC/AHA anticoagulation guidance — INR monitoring on warfarin";
const LITHIUM_REF =
  "Lithium prescribing information — serum level, thyroid, and renal monitoring";
const AED_REF =
  "Antiepileptic (valproate/carbamazepine) prescribing information — CBC, LFTs, and drug-level monitoring";
const ADA_APA_METABOLIC =
  "ADA/APA consensus on antipsychotic metabolic monitoring";
const AMIODARONE_REF =
  "Amiodarone prescribing information — thyroid and hepatic monitoring";
const MTX_REF =
  "Methotrexate prescribing information — CBC, hepatic, and renal monitoring";
const ACEI_REF =
  "ACE-inhibitor / ARB prescribing guidance — creatinine and potassium monitoring";
const METFORMIN_REF =
  "Metformin prescribing information — renal function and vitamin B12 monitoring";

// Common labs, spelled to the CANONICAL biomarker names (lib/canonical-biomarkers.json)
// wherever one exists, so a real reading satisfies the requirement family-aware.
const TSH = {
  canonical: "Thyroid-Stimulating Hormone (TSH)",
  label: "TSH (thyroid)",
};
const FREE_T4 = { canonical: "Free T4", label: "Free T4" };
const CREATININE = { canonical: "Creatinine", label: "creatinine" };
const EGFR = { canonical: "eGFR", label: "eGFR (kidney function)" };
const CALCIUM = { canonical: "Calcium", label: "calcium" };
const POTASSIUM = { canonical: "Potassium", label: "potassium" };
const SODIUM = { canonical: "Sodium", label: "sodium" };
const ALT = {
  canonical: "Alanine Aminotransferase (ALT)",
  label: "ALT (liver)",
};
const AST = {
  canonical: "Aspartate Aminotransferase (AST)",
  label: "AST (liver)",
};
const WBC = { canonical: "White Blood Cell Count", label: "CBC (white cells)" };
const ANC = {
  canonical: "Neutrophils, Absolute",
  label: "ANC (neutrophil count)",
};
const A1C = { canonical: "Hemoglobin A1c", label: "HbA1c" };
const GLUCOSE = { canonical: "Glucose", label: "fasting glucose" };
const LDL = { canonical: "LDL Cholesterol", label: "LDL cholesterol" };
const HDL = { canonical: "HDL Cholesterol", label: "HDL cholesterol" };
const TRIG = { canonical: "Triglycerides", label: "triglycerides" };
const B12 = { canonical: "Vitamin B12", label: "vitamin B12" };
// Drug-level monitors that aren't standard canonical biomarkers — the reading's own name
// is its family identity (#482), so a level recorded under this name satisfies it.
const LITHIUM_LEVEL = { canonical: "Lithium", label: "lithium level" };
const VALPROATE_LEVEL = { canonical: "Valproate", label: "valproate level" };
const CARBAMAZEPINE_LEVEL = {
  canonical: "Carbamazepine",
  label: "carbamazepine level",
};
const INR = { canonical: "INR", label: "INR" };

// The curated table. CARE tier (#995 decision 1): lithium, clozapine, warfarin,
// valproate, carbamazepine — a missed monitor is genuinely dangerous. COACHING tier: the
// gentler metabolic/organ surveillance (antipsychotic metabolic panel, amiodarone,
// methotrexate, ACEi/ARB, metformin).
const DRUGS: MedMonitoringEntry[] = [
  {
    key: "lithium",
    label: "Lithium",
    rxcuis: [],
    synonyms: [
      "lithium",
      "lithium carbonate",
      "lithium citrate",
      "eskalith",
      "lithobid",
    ],
    labs: [LITHIUM_LEVEL, TSH, CREATININE, EGFR, CALCIUM],
    baseline: true,
    initDays: 30,
    maintenanceDays: 180,
    tier: "care",
    note: "Lithium has a narrow therapeutic range, so clinicians typically check the serum lithium level frequently after starting or a dose change, then about every 6 months once stable, along with thyroid (TSH), kidney function (creatinine/eGFR), and calcium.",
    source: LITHIUM_REF,
  },
  {
    key: "clozapine",
    label: "Clozapine",
    rxcuis: [],
    synonyms: ["clozapine", "clozaril", "fazaclo", "versacloz"],
    labs: [ANC, WBC],
    baseline: true,
    initDays: 7,
    maintenanceDays: 30,
    tier: "care",
    note: "Clozapine requires close monitoring of the absolute neutrophil count (ANC) — typically weekly early on, then less often — because it can rarely lower the white-cell count. This is generally managed through a formal monitoring program.",
    source: FDA_CLOZAPINE,
  },
  {
    key: "warfarin",
    label: "Warfarin",
    rxcuis: [],
    synonyms: ["warfarin", "coumadin", "jantoven"],
    labs: [INR],
    baseline: false,
    initDays: 7,
    maintenanceDays: 30,
    tier: "care",
    note: "Warfarin dosing is guided by the INR blood test, checked often when starting or after a dose change and then usually about every 4 weeks once the level is stable.",
    source: ACC_AHA_WARFARIN,
  },
  {
    key: "valproate",
    label: "Valproate / divalproex",
    rxcuis: [],
    synonyms: [
      "valproate",
      "valproic acid",
      "divalproex",
      "divalproex sodium",
      "depakote",
      "depakene",
      "sodium valproate",
    ],
    labs: [ALT, AST, WBC, VALPROATE_LEVEL],
    baseline: true,
    initDays: 30,
    maintenanceDays: 180,
    tier: "care",
    note: "Valproate is commonly monitored with liver tests (ALT/AST), a blood count (CBC), and sometimes a drug level — more often after starting or a dose change, then periodically.",
    source: AED_REF,
  },
  {
    key: "carbamazepine",
    label: "Carbamazepine",
    rxcuis: [],
    synonyms: ["carbamazepine", "tegretol", "carbatrol", "equetro", "epitol"],
    labs: [WBC, ALT, AST, SODIUM, CARBAMAZEPINE_LEVEL],
    baseline: true,
    initDays: 30,
    maintenanceDays: 180,
    tier: "care",
    note: "Carbamazepine is commonly monitored with a blood count (CBC), liver tests (ALT/AST), sodium, and sometimes a drug level — more often early on, then periodically.",
    source: AED_REF,
  },
  {
    key: "second_gen_antipsychotic",
    label: "Second-generation antipsychotics",
    rxcuis: [],
    synonyms: [
      "olanzapine",
      "zyprexa",
      "quetiapine",
      "seroquel",
      "risperidone",
      "risperdal",
      "paliperidone",
      "invega",
      "aripiprazole",
      "abilify",
      "ziprasidone",
      "geodon",
      "lurasidone",
      "latuda",
      "asenapine",
      "saphris",
      "clozapine",
      "clozaril",
    ],
    labs: [A1C, GLUCOSE, LDL, HDL, TRIG],
    baseline: true,
    initDays: 90,
    maintenanceDays: 365,
    tier: "coaching",
    note: "Second-generation antipsychotics can affect blood sugar, cholesterol, and weight, so clinicians commonly check fasting glucose or HbA1c and a lipid panel around starting and then periodically (metabolic monitoring).",
    source: ADA_APA_METABOLIC,
  },
  {
    key: "amiodarone",
    label: "Amiodarone",
    rxcuis: [],
    synonyms: ["amiodarone", "cordarone", "pacerone", "nexterone"],
    labs: [TSH, FREE_T4, ALT, AST],
    baseline: true,
    initDays: 90,
    maintenanceDays: 180,
    tier: "coaching",
    note: "Amiodarone can affect the thyroid and liver over time, so thyroid tests (TSH/Free T4) and liver tests (ALT/AST) are commonly checked around starting and then about every 6 months.",
    source: AMIODARONE_REF,
  },
  {
    key: "methotrexate",
    label: "Methotrexate",
    rxcuis: [],
    synonyms: ["methotrexate", "trexall", "rasuvo", "otrexup", "xatmep"],
    labs: [WBC, ALT, AST, CREATININE],
    baseline: true,
    initDays: 30,
    maintenanceDays: 90,
    tier: "coaching",
    note: "Low-dose methotrexate is commonly monitored with a blood count (CBC), liver tests (ALT/AST), and kidney function — more often after starting or a dose change, then periodically.",
    source: MTX_REF,
  },
  {
    key: "acei_arb",
    label: "ACE inhibitors / ARBs",
    rxcuis: [],
    synonyms: [
      "lisinopril",
      "zestril",
      "prinivil",
      "enalapril",
      "vasotec",
      "ramipril",
      "altace",
      "benazepril",
      "lotensin",
      "quinapril",
      "perindopril",
      "losartan",
      "cozaar",
      "valsartan",
      "diovan",
      "olmesartan",
      "benicar",
      "candesartan",
      "atacand",
      "irbesartan",
      "avapro",
      "telmisartan",
      "micardis",
    ],
    labs: [CREATININE, EGFR, POTASSIUM],
    baseline: false,
    initDays: 14,
    maintenanceDays: 365,
    tier: "coaching",
    note: "ACE inhibitors and ARBs can affect kidney function and potassium, so creatinine/eGFR and potassium are commonly checked shortly after starting or a dose change and then periodically.",
    source: ACEI_REF,
  },
  {
    key: "metformin",
    label: "Metformin",
    rxcuis: [],
    synonyms: ["metformin", "glucophage", "fortamet", "glumetza", "riomet"],
    labs: [CREATININE, EGFR, B12],
    baseline: false,
    initDays: 90,
    maintenanceDays: 365,
    tier: "coaching",
    note: "Metformin is commonly monitored with kidney function (creatinine/eGFR) periodically, and vitamin B12 is sometimes checked with long-term use.",
    source: METFORMIN_REF,
  },
];

export function buildMedMonitoringDataset(): MedMonitoringDataset {
  const drugs: MedMonitoringEntry[] = DRUGS.map((d) => ({
    key: d.key,
    label: d.label,
    rxcuis: [...new Set(d.rxcuis)].sort(),
    synonyms: norm(d.synonyms),
    labs: d.labs,
    baseline: d.baseline,
    initDays: d.initDays,
    maintenanceDays: d.maintenanceDays,
    tier: d.tier,
    note: d.note,
    source: d.source,
  })).sort((a, b) => a.key.localeCompare(b.key));

  return {
    $schema: DATASET_SCHEMA,
    id: "medication-monitoring",
    title: "Medication monitoring-lab bridge",
    description:
      "Baked medication-monitoring dataset (issue #995) — the bridge between an ACTIVE " +
      "medication and the periodic labs a clinician typically monitors while it is taken. " +
      "Each entry carries the required monitoring labs (by canonical biomarker name, so a " +
      "matching result satisfies the retest clock family-aware), a baseline-needed flag, an " +
      "init cadence (tighter right after starting / a dose change) and a maintenance " +
      "cadence, a per-entry reach tier (care pushes, coaching is calm), and a citation. " +
      "Drugs match by RxNorm ingredient + synonym (the shared machinery). INFORMATIONAL, " +
      "never prescriptive — it never says get a test or change a drug, and the absence of an " +
      "entry is NOT clearance (a curated subset). Fully OFFLINE. Committed + HUMAN-REVIEWABLE; " +
      "regenerate with `npm run gen:medication-monitoring`.",
    citation: [
      {
        source: LITHIUM_REF,
        note: "Uncopyrightable clinical facts (lithium is monitored with a serum level, thyroid, and renal tests) stated in our own words; drug names are public nomenclature.",
      },
      {
        source: FDA_CLOZAPINE,
        url: "https://www.newclozapinerems.com/",
        note: "The clozapine ANC-monitoring requirement is a public FDA REMS fact, stated in our own words.",
      },
      {
        source: ACC_AHA_WARFARIN,
        note: "Warfarin INR monitoring is a well-established clinical fact, stated in our own words.",
      },
      {
        source: AED_REF,
        note: "Valproate/carbamazepine CBC/LFT/level monitoring is stated in our own words from the public prescribing information.",
      },
      {
        source: ADA_APA_METABOLIC,
        note: "Antipsychotic metabolic monitoring (glucose/HbA1c + lipids) is a public consensus fact, stated in our own words.",
      },
      {
        source: AMIODARONE_REF,
        note: "Amiodarone thyroid/hepatic monitoring is stated in our own words from the public prescribing information.",
      },
      {
        source: MTX_REF,
        note: "Methotrexate CBC/hepatic/renal monitoring is stated in our own words from the public prescribing information.",
      },
      {
        source: ACEI_REF,
        note: "ACEi/ARB creatinine + potassium monitoring is a well-established clinical fact, stated in our own words.",
      },
      {
        source: METFORMIN_REF,
        note: "Metformin renal + B12 monitoring is stated in our own words from the public prescribing information.",
      },
    ],
    identity: { keys: ["key"] },
    meta: { version: 1 },
    entries: drugs,
  };
}

function writeDataset(): void {
  const dataset = buildMedMonitoringDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} medication-monitoring entries to ${OUT}`
  );
  console.log("Review the table for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the drift test imports
// buildMedMonitoringDataset).
if (process.argv[1]?.includes("gen-medication-monitoring")) {
  writeDataset();
}
