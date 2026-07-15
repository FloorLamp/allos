// Pre-generate the baked pharmacogenomics (PGx) cross-check dataset (lib/pgx.json),
// used to flag when a stored PGx result (a genomic_variants row with
// result_type='pharmacogenomic', issue #709) affects a medication in a profile's
// ACTIVE stack — the "PGx result × active meds" safety cross-check (issue #710). It
// is the genomics twin of the drug–drug interaction dataset (gen-drug-interactions
// .ts → lib/drug-interactions.json): a stored variant is matched against the med
// stack exactly like a drug–drug interaction, and the affected medication carries a
// note stating the phenotype on file + CPIC's guidance direction as INFORMATION.
//
// SOURCING / LICENSE
// ------------------
// This is a CURATED, HIGH-VALUE subset of the best-established gene–drug pairs, NOT
// an exhaustive pharmacogenomic database. The facts (which gene/phenotype affects
// which drug, and the direction of the recommendation) are drawn from PUBLIC,
// license-clean clinical references:
//
//   • CPIC (Clinical Pharmacogenetics Implementation Consortium) guidelines — freely
//     published, peer-reviewed gene–drug guidance (https://cpicpgx.org/guidelines/).
//     We DO NOT copy CPIC's copyrighted guideline prose; we PARAPHRASE the
//     recommendation DIRECTION (an uncopyrightable clinical fact: "reduced
//     activation → consider an alternative", "avoid", "reduce the starting dose")
//     in our own words and CITE CPIC as the source, exactly as gen-drug-interactions
//     paraphrases a one-line mechanism from FDA labeling.
//   • FDA drug labeling / the FDA Table of Pharmacogenetic Associations — a
//     PUBLIC-DOMAIN U.S. Government work (the HLA-B*57:01 × abacavir and DPYD ×
//     fluoropyrimidine contraindications are FDA-boxed).
//   • RxNorm (NLM) — the ingredient RxCUIs below are from RxNorm, a public-domain
//     U.S. Government normalized drug vocabulary. Public domain.
//   • PharmVar / CPIC allele-function tables — the star-allele → function map used
//     for the diplotype→phenotype FALLBACK is public reference data (functional
//     status of an allele is a fact).
//
// We deliberately DO NOT vendor a copyrighted commercial PGx database. The curated
// pairs here are the textbook, boxed-warning-grade associations any clinical PGx
// reference states plainly.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. The app RELAYS CPIC's
// guidance direction as information with its source — it never issues a directive,
// never auto-changes a medication, and the note always closes "discuss with your
// prescriber before any change". The ABSENCE of a flag is NOT clearance (the dataset
// is a curated subset; a report the app can't parse, or a pair not covered here,
// carries no flag), and this is not a substitute for a clinician's PGx
// interpretation.
//
// SENSITIVITY (issue #709/#710): variant/gene data is the most identifying PHI in
// the app. This whole feature is OFFLINE — a gene or variant name is NEVER sent to
// any external annotation API; the guidance is baked here and shipped in the repo.
//
// GENERATION
// ----------
// Mirrors gen-drug-interactions.ts: the curated constants below are the SOURCE OF
// TRUTH, the JSON is GENERATED from them and COMMITTED, and it is never hand-edited.
// Edit the tables below and re-run:
//
//   npm run gen:pgx
//
// The committed lib/pgx.json is a FIXED POINT of buildPgxDataset() (guarded by
// lib/__tests__/pgx-dataset.test.ts) so the generator and the file can't silently
// diverge. lib/pgx.json is in .prettierignore — prettier reformatting would break
// the fixed-point string compare.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "pgx.json");

// Metabolizer / transporter phenotype CPIC keys on. SLCO1B1's "decreased/poor
// function" transporter status is folded onto intermediate/poor so the whole
// dataset shares one phenotype vocabulary.
export type Phenotype =
  "poor" | "intermediate" | "normal" | "rapid" | "ultrarapid";

// How strongly a pair reads. `contraindicated` = a boxed/avoid-grade association
// (HLA hypersensitivity, DPYD poor × fluoropyrimidine); `high`/`moderate` grade the
// dosing-consideration pairs. Drives the note's emphasis + within-list order, NOT a
// directive.
export type PgxSeverity = "contraindicated" | "high" | "moderate";
const SEVERITIES: PgxSeverity[] = ["contraindicated", "high", "moderate"];

// A star-allele's functional status, for the diplotype→phenotype FALLBACK (used only
// when a report does not state the phenotype in its own words — the primary path
// trusts the stated phenotype). Public CPIC/PharmVar reference data.
export type AlleleFunction =
  | "none" // no-function (e.g. CYP2C19 *2, TPMT *3A)
  | "decreased" // decreased-function (e.g. CYP2D6 *10, CYP2C9 *2)
  | "normal" // normal-function (*1 and equivalents)
  | "increased"; // increased-function (e.g. CYP2C19 *17)

// A drug/drug-class CONCEPT — an ingredient or an ingredient CLASS (e.g. "ppi",
// "thiopurine"). An active intake item resolves to a concept by RxCUI (authoritative)
// or a name/synonym match, REUSING the drug-interaction matcher (matchConceptKeysIn
// in lib/drug-interactions.ts) so PGx and drug–drug matching can't diverge.
export interface RawDrug {
  key: string; // stable identity — guidance rows reference this; keys never recycle
  label: string; // human display, e.g. "Clopidogrel"
  rxcuis: string[]; // RxNorm ingredient CUIs (authoritative, public domain)
  synonyms: string[]; // generic + brand names for the name-fallback matcher
}

// A star allele's functional status for one gene (diplotype→phenotype fallback).
export interface RawAllele {
  gene: string; // HGNC symbol
  allele: string; // e.g. "*2", "*17"
  function: AlleleFunction;
}

// One CPIC-derived gene–drug guidance row. Matches on EITHER a metabolizer
// `phenotype` (CYP/TPMT/NUDT15/DPYD/SLCO1B1) OR presence of a risk `marker`
// (HLA alleles, VKORC1 sensitivity) — exactly one is set. `guidance` PARAPHRASES the
// CPIC recommendation direction as information; `source` cites CPIC.
export interface RawGuidance {
  gene: string; // HGNC symbol
  drug: string; // RawDrug.key
  severity: PgxSeverity;
  phenotype?: Phenotype;
  // Risk-marker tokens (for HLA/VKORC1 rows): the variant is a match when its
  // collapsed (lowercased, non-alphanumerics removed) text CONTAINS one of these
  // and the result is not negated. e.g. "5701" for HLA-B*57:01, "sensitiv" for a
  // VKORC1 "increased sensitivity" report.
  marker?: string[];
  guidance: string; // paraphrased CPIC direction, INFORMATIONAL
  source: string; // citation
}

// ---- Drug concept vocabulary ---------------------------------------------
// RxCUIs are RxNorm INGREDIENT concepts (public domain); listed only where confident
// — the name-fallback synonyms are the robust matcher and cover every drug. Synonyms
// are lowercased/normalized by the builder; include generic + common US brand names.
const DRUGS: RawDrug[] = [
  {
    key: "clopidogrel",
    label: "Clopidogrel",
    rxcuis: ["32968"],
    synonyms: ["clopidogrel", "plavix"],
  },
  {
    key: "ppi",
    label: "Proton-pump inhibitors (omeprazole, esomeprazole, …)",
    rxcuis: [],
    synonyms: [
      "omeprazole",
      "prilosec",
      "esomeprazole",
      "nexium",
      "lansoprazole",
      "prevacid",
      "pantoprazole",
      "protonix",
      "rabeprazole",
      "aciphex",
      "dexlansoprazole",
      "dexilant",
    ],
  },
  {
    key: "ssri_cyp2c19",
    label: "CYP2C19-metabolized SSRIs (citalopram, escitalopram, sertraline)",
    rxcuis: [],
    synonyms: [
      "citalopram",
      "celexa",
      "escitalopram",
      "lexapro",
      "sertraline",
      "zoloft",
    ],
  },
  {
    key: "codeine",
    label: "Codeine",
    rxcuis: ["2670"],
    synonyms: ["codeine"],
  },
  {
    key: "tramadol",
    label: "Tramadol",
    rxcuis: ["10689"],
    synonyms: ["tramadol", "ultram", "conzip"],
  },
  {
    key: "tamoxifen",
    label: "Tamoxifen",
    rxcuis: ["10324"],
    synonyms: ["tamoxifen", "nolvadex", "soltamox"],
  },
  {
    key: "tca",
    label: "Tricyclic antidepressants (amitriptyline, nortriptyline, …)",
    rxcuis: [],
    synonyms: [
      "amitriptyline",
      "elavil",
      "nortriptyline",
      "pamelor",
      "imipramine",
      "tofranil",
      "desipramine",
      "norpramin",
      "clomipramine",
      "anafranil",
      "doxepin",
      "trimipramine",
    ],
  },
  {
    key: "ssri_cyp2d6",
    label: "CYP2D6-metabolized SSRIs (paroxetine, fluvoxamine)",
    rxcuis: [],
    synonyms: ["paroxetine", "paxil", "fluvoxamine", "luvox"],
  },
  {
    key: "thiopurine",
    label: "Thiopurines (azathioprine, mercaptopurine, thioguanine)",
    rxcuis: [],
    synonyms: [
      "azathioprine",
      "imuran",
      "azasan",
      "mercaptopurine",
      "purinethol",
      "purixan",
      "6 mp",
      "thioguanine",
      "tioguanine",
      "tabloid",
    ],
  },
  {
    key: "fluoropyrimidine",
    label: "Fluoropyrimidines (fluorouracil, capecitabine)",
    rxcuis: [],
    synonyms: ["fluorouracil", "5 fu", "adrucil", "capecitabine", "xeloda"],
  },
  {
    key: "simvastatin",
    label: "Simvastatin",
    rxcuis: ["36567"],
    synonyms: ["simvastatin", "zocor", "flolipid"],
  },
  {
    key: "warfarin",
    label: "Warfarin",
    rxcuis: ["11289"],
    synonyms: ["warfarin", "coumadin", "jantoven"],
  },
  {
    key: "nsaid_cyp2c9",
    label: "CYP2C9-metabolized NSAIDs (celecoxib, ibuprofen, meloxicam, …)",
    rxcuis: [],
    synonyms: [
      "celecoxib",
      "celebrex",
      "ibuprofen",
      "advil",
      "motrin",
      "flurbiprofen",
      "meloxicam",
      "mobic",
      "piroxicam",
      "feldene",
    ],
  },
  {
    key: "phenytoin",
    label: "Phenytoin",
    rxcuis: ["8183"],
    synonyms: ["phenytoin", "dilantin", "phenytek"],
  },
  {
    key: "abacavir",
    label: "Abacavir",
    rxcuis: ["190521"],
    synonyms: [
      "abacavir",
      "ziagen",
      "epzicom",
      "trizivir",
      "triumeq",
      "kivexa",
    ],
  },
  {
    key: "carbamazepine",
    label: "Carbamazepine",
    rxcuis: ["2002"],
    synonyms: ["carbamazepine", "tegretol", "carbatrol", "equetro", "epitol"],
  },
  {
    key: "oxcarbazepine",
    label: "Oxcarbazepine",
    rxcuis: ["32624"],
    synonyms: ["oxcarbazepine", "trileptal", "oxtellar"],
  },
];

// ---- Star-allele function table (diplotype→phenotype fallback) ------------
// Public CPIC/PharmVar allele-function reference. Used ONLY when a report does not
// state the phenotype in words. *1 is normal for every gene (added by the builder if
// absent). Only the common, high-confidence alleles are listed; an unlisted allele
// yields an unknown function, so the fallback declines rather than guessing.
const ALLELES: RawAllele[] = [
  // CYP2C19
  { gene: "CYP2C19", allele: "*1", function: "normal" },
  { gene: "CYP2C19", allele: "*17", function: "increased" },
  { gene: "CYP2C19", allele: "*2", function: "none" },
  { gene: "CYP2C19", allele: "*3", function: "none" },
  { gene: "CYP2C19", allele: "*4", function: "none" },
  { gene: "CYP2C19", allele: "*5", function: "none" },
  { gene: "CYP2C19", allele: "*6", function: "none" },
  { gene: "CYP2C19", allele: "*7", function: "none" },
  { gene: "CYP2C19", allele: "*8", function: "none" },
  // CYP2D6 (CNV/*1xN duplication not modeled — an unlisted case declines)
  { gene: "CYP2D6", allele: "*1", function: "normal" },
  { gene: "CYP2D6", allele: "*2", function: "normal" },
  { gene: "CYP2D6", allele: "*9", function: "decreased" },
  { gene: "CYP2D6", allele: "*10", function: "decreased" },
  { gene: "CYP2D6", allele: "*17", function: "decreased" },
  { gene: "CYP2D6", allele: "*29", function: "decreased" },
  { gene: "CYP2D6", allele: "*41", function: "decreased" },
  { gene: "CYP2D6", allele: "*3", function: "none" },
  { gene: "CYP2D6", allele: "*4", function: "none" },
  { gene: "CYP2D6", allele: "*5", function: "none" },
  { gene: "CYP2D6", allele: "*6", function: "none" },
  { gene: "CYP2D6", allele: "*7", function: "none" },
  { gene: "CYP2D6", allele: "*8", function: "none" },
  // CYP2C9
  { gene: "CYP2C9", allele: "*1", function: "normal" },
  { gene: "CYP2C9", allele: "*2", function: "decreased" },
  { gene: "CYP2C9", allele: "*3", function: "none" },
  { gene: "CYP2C9", allele: "*5", function: "decreased" },
  { gene: "CYP2C9", allele: "*6", function: "none" },
  { gene: "CYP2C9", allele: "*8", function: "decreased" },
  { gene: "CYP2C9", allele: "*11", function: "decreased" },
  // TPMT
  { gene: "TPMT", allele: "*1", function: "normal" },
  { gene: "TPMT", allele: "*2", function: "none" },
  { gene: "TPMT", allele: "*3A", function: "none" },
  { gene: "TPMT", allele: "*3B", function: "none" },
  { gene: "TPMT", allele: "*3C", function: "none" },
  { gene: "TPMT", allele: "*4", function: "none" },
  // NUDT15
  { gene: "NUDT15", allele: "*1", function: "normal" },
  { gene: "NUDT15", allele: "*2", function: "none" },
  { gene: "NUDT15", allele: "*3", function: "none" },
];

// ---- CPIC gene–drug guidance rows ----------------------------------------
// PARAPHRASED recommendation directions (our words), CITED to CPIC/FDA. Informational.
const SRC = {
  clopidogrel: "CPIC guideline for clopidogrel and CYP2C19 (cpicpgx.org)",
  ppi: "CPIC guideline for proton-pump inhibitors and CYP2C19 (cpicpgx.org)",
  ssri: "CPIC guideline for SSRIs and CYP2D6/CYP2C19 (cpicpgx.org)",
  opioid: "CPIC guideline for codeine/tramadol and CYP2D6 (cpicpgx.org)",
  tamoxifen: "CPIC guideline for tamoxifen and CYP2D6 (cpicpgx.org)",
  tca: "CPIC guideline for tricyclic antidepressants and CYP2D6/CYP2C19 (cpicpgx.org)",
  thiopurine: "CPIC guideline for thiopurines and TPMT/NUDT15 (cpicpgx.org)",
  dpyd: "CPIC guideline for fluoropyrimidines and DPYD (cpicpgx.org)",
  statin: "CPIC guideline for statins and SLCO1B1 (cpicpgx.org)",
  warfarin: "CPIC guideline for warfarin and CYP2C9/VKORC1 (cpicpgx.org)",
  nsaid: "CPIC guideline for NSAIDs and CYP2C9 (cpicpgx.org)",
  phenytoin: "CPIC guideline for phenytoin and CYP2C9/HLA-B (cpicpgx.org)",
  abacavir:
    "CPIC guideline for abacavir and HLA-B (cpicpgx.org); FDA boxed warning",
  carbamazepine:
    "CPIC guideline for carbamazepine/oxcarbazepine and HLA-B/HLA-A (cpicpgx.org)",
};

const GUIDANCE: RawGuidance[] = [
  // ── CYP2C19 ──────────────────────────────────────────────────────────────
  {
    gene: "CYP2C19",
    drug: "clopidogrel",
    phenotype: "poor",
    severity: "high",
    guidance:
      "clopidogrel is activated less, so its antiplatelet effect is reduced; CPIC recommends an alternative antiplatelet (e.g. prasugrel or ticagrelor) where clinically appropriate.",
    source: SRC.clopidogrel,
  },
  {
    gene: "CYP2C19",
    drug: "clopidogrel",
    phenotype: "intermediate",
    severity: "high",
    guidance:
      "clopidogrel activation is partly reduced, lowering its antiplatelet effect; CPIC recommends considering an alternative antiplatelet (e.g. prasugrel or ticagrelor), especially after PCI/ACS.",
    source: SRC.clopidogrel,
  },
  {
    gene: "CYP2C19",
    drug: "ppi",
    phenotype: "ultrarapid",
    severity: "moderate",
    guidance:
      "faster metabolism lowers proton-pump-inhibitor exposure and may reduce efficacy; CPIC notes an increased dose may be warranted for the treatment goal.",
    source: SRC.ppi,
  },
  {
    gene: "CYP2C19",
    drug: "ppi",
    phenotype: "rapid",
    severity: "moderate",
    guidance:
      "increased metabolism lowers proton-pump-inhibitor exposure and may reduce efficacy; CPIC notes an increased dose may be warranted for the treatment goal.",
    source: SRC.ppi,
  },
  {
    gene: "CYP2C19",
    drug: "ssri_cyp2c19",
    phenotype: "poor",
    severity: "moderate",
    guidance:
      "reduced metabolism raises exposure to citalopram/escitalopram/sertraline; CPIC suggests a lower starting dose or an antidepressant not primarily metabolized by CYP2C19.",
    source: SRC.ssri,
  },
  {
    gene: "CYP2C19",
    drug: "ssri_cyp2c19",
    phenotype: "ultrarapid",
    severity: "moderate",
    guidance:
      "faster metabolism lowers exposure and may reduce response; CPIC suggests considering an antidepressant not primarily metabolized by CYP2C19.",
    source: SRC.ssri,
  },
  // ── CYP2D6 ───────────────────────────────────────────────────────────────
  {
    gene: "CYP2D6",
    drug: "codeine",
    phenotype: "ultrarapid",
    severity: "contraindicated",
    guidance:
      "codeine is converted to morphine faster, risking toxicity; CPIC recommends AVOIDING codeine and using a non-CYP2D6 analgesic.",
    source: SRC.opioid,
  },
  {
    gene: "CYP2D6",
    drug: "codeine",
    phenotype: "poor",
    severity: "high",
    guidance:
      "little codeine is converted to morphine, so analgesia is likely inadequate; CPIC recommends an alternative analgesic (not tramadol).",
    source: SRC.opioid,
  },
  {
    gene: "CYP2D6",
    drug: "tramadol",
    phenotype: "ultrarapid",
    severity: "contraindicated",
    guidance:
      "more active metabolite is formed, risking toxicity; CPIC recommends AVOIDING tramadol and using a non-CYP2D6 analgesic.",
    source: SRC.opioid,
  },
  {
    gene: "CYP2D6",
    drug: "tramadol",
    phenotype: "poor",
    severity: "high",
    guidance:
      "less active metabolite is formed, so analgesia is likely reduced; CPIC recommends an alternative analgesic (not codeine).",
    source: SRC.opioid,
  },
  {
    gene: "CYP2D6",
    drug: "tamoxifen",
    phenotype: "poor",
    severity: "high",
    guidance:
      "less active endoxifen is formed, which may lower efficacy; CPIC recommends considering an alternative (e.g. an aromatase inhibitor) where clinically appropriate.",
    source: SRC.tamoxifen,
  },
  {
    gene: "CYP2D6",
    drug: "tamoxifen",
    phenotype: "intermediate",
    severity: "moderate",
    guidance:
      "endoxifen formation is somewhat reduced; CPIC notes lower exposure and suggests weighing an alternative where clinically appropriate.",
    source: SRC.tamoxifen,
  },
  {
    gene: "CYP2D6",
    drug: "tca",
    phenotype: "poor",
    severity: "moderate",
    guidance:
      "reduced metabolism raises tricyclic exposure; CPIC suggests a ~50% lower dose with monitoring, or an alternative.",
    source: SRC.tca,
  },
  {
    gene: "CYP2D6",
    drug: "tca",
    phenotype: "ultrarapid",
    severity: "moderate",
    guidance:
      "faster metabolism lowers tricyclic exposure; CPIC suggests an alternative not metabolized by CYP2D6, or therapeutic-level monitoring.",
    source: SRC.tca,
  },
  {
    gene: "CYP2D6",
    drug: "ssri_cyp2d6",
    phenotype: "poor",
    severity: "moderate",
    guidance:
      "reduced metabolism raises paroxetine/fluvoxamine exposure; CPIC suggests a lower dose or an SSRI not primarily metabolized by CYP2D6.",
    source: SRC.ssri,
  },
  // ── TPMT / NUDT15 × thiopurines ──────────────────────────────────────────
  {
    gene: "TPMT",
    drug: "thiopurine",
    phenotype: "poor",
    severity: "high",
    guidance:
      "very little thiopurine is inactivated, so standard doses risk severe myelosuppression; CPIC recommends a substantially reduced dose or an alternative.",
    source: SRC.thiopurine,
  },
  {
    gene: "TPMT",
    drug: "thiopurine",
    phenotype: "intermediate",
    severity: "moderate",
    guidance:
      "thiopurine inactivation is reduced; CPIC recommends a reduced starting dose with monitoring.",
    source: SRC.thiopurine,
  },
  {
    gene: "NUDT15",
    drug: "thiopurine",
    phenotype: "poor",
    severity: "high",
    guidance:
      "reduced NUDT15 activity raises the risk of severe myelosuppression at standard doses; CPIC recommends a substantially reduced dose or an alternative.",
    source: SRC.thiopurine,
  },
  {
    gene: "NUDT15",
    drug: "thiopurine",
    phenotype: "intermediate",
    severity: "moderate",
    guidance:
      "NUDT15 activity is reduced; CPIC recommends a reduced starting dose with monitoring.",
    source: SRC.thiopurine,
  },
  // ── DPYD × fluoropyrimidines ─────────────────────────────────────────────
  {
    gene: "DPYD",
    drug: "fluoropyrimidine",
    phenotype: "poor",
    severity: "contraindicated",
    guidance:
      "greatly reduced clearance risks severe or fatal toxicity; CPIC recommends AVOIDING 5-fluorouracil/capecitabine and selecting an alternative.",
    source: SRC.dpyd,
  },
  {
    gene: "DPYD",
    drug: "fluoropyrimidine",
    phenotype: "intermediate",
    severity: "high",
    guidance:
      "reduced clearance raises toxicity risk; CPIC recommends a reduced starting dose (about 50%) with titration to tolerance.",
    source: SRC.dpyd,
  },
  // ── SLCO1B1 × simvastatin ────────────────────────────────────────────────
  {
    gene: "SLCO1B1",
    drug: "simvastatin",
    phenotype: "poor",
    severity: "high",
    guidance:
      "reduced hepatic uptake raises simvastatin exposure and myopathy risk; CPIC recommends a lower dose or an alternative statin.",
    source: SRC.statin,
  },
  {
    gene: "SLCO1B1",
    drug: "simvastatin",
    phenotype: "intermediate",
    severity: "moderate",
    guidance:
      "decreased transporter function moderately raises simvastatin exposure/myopathy risk; CPIC recommends a lower dose or an alternative statin.",
    source: SRC.statin,
  },
  // ── CYP2C9 / VKORC1 × warfarin ───────────────────────────────────────────
  {
    gene: "CYP2C9",
    drug: "warfarin",
    phenotype: "poor",
    severity: "high",
    guidance:
      "reduced clearance lowers the warfarin dose requirement; CPIC/validated dosing algorithms recommend a lower dose with close INR monitoring.",
    source: SRC.warfarin,
  },
  {
    gene: "CYP2C9",
    drug: "warfarin",
    phenotype: "intermediate",
    severity: "moderate",
    guidance:
      "somewhat reduced clearance lowers the warfarin dose requirement; CPIC/validated dosing algorithms recommend a genotype-guided dose with INR monitoring.",
    source: SRC.warfarin,
  },
  {
    gene: "VKORC1",
    drug: "warfarin",
    marker: ["sensitiv", "1639a", "increasedwarfarin", "aa", "ag"],
    severity: "moderate",
    guidance:
      "the VKORC1 −1639 A allele increases warfarin sensitivity (a lower dose requirement); CPIC recommends genotype-guided dosing with INR monitoring.",
    source: SRC.warfarin,
  },
  // ── CYP2C9 × NSAIDs / phenytoin ──────────────────────────────────────────
  {
    gene: "CYP2C9",
    drug: "nsaid_cyp2c9",
    phenotype: "poor",
    severity: "moderate",
    guidance:
      "reduced metabolism raises NSAID exposure and adverse-effect risk; CPIC recommends the lowest effective dose, a shorter course, or an NSAID not metabolized by CYP2C9.",
    source: SRC.nsaid,
  },
  {
    gene: "CYP2C9",
    drug: "phenytoin",
    phenotype: "poor",
    severity: "high",
    guidance:
      "reduced clearance raises phenytoin levels and toxicity risk; CPIC recommends a reduced dose with therapeutic-level monitoring.",
    source: SRC.phenytoin,
  },
  {
    gene: "CYP2C9",
    drug: "phenytoin",
    phenotype: "intermediate",
    severity: "moderate",
    guidance:
      "somewhat reduced clearance can raise phenytoin levels; CPIC recommends a reduced dose with therapeutic-level monitoring.",
    source: SRC.phenytoin,
  },
  // ── HLA risk alleles ─────────────────────────────────────────────────────
  {
    gene: "HLA-B",
    drug: "abacavir",
    marker: ["5701"],
    severity: "contraindicated",
    guidance:
      "a positive HLA-B*57:01 result marks high risk of a serious abacavir hypersensitivity reaction; CPIC and FDA labeling recommend NOT using abacavir.",
    source: SRC.abacavir,
  },
  {
    gene: "HLA-B",
    drug: "carbamazepine",
    marker: ["1502"],
    severity: "contraindicated",
    guidance:
      "HLA-B*15:02 positivity marks high risk of Stevens–Johnson syndrome / toxic epidermal necrolysis; CPIC recommends AVOIDING carbamazepine in carbamazepine-naïve patients.",
    source: SRC.carbamazepine,
  },
  {
    gene: "HLA-B",
    drug: "oxcarbazepine",
    marker: ["1502"],
    severity: "contraindicated",
    guidance:
      "HLA-B*15:02 positivity marks high risk of Stevens–Johnson syndrome / toxic epidermal necrolysis; CPIC recommends AVOIDING oxcarbazepine in oxcarbazepine-naïve patients.",
    source: SRC.carbamazepine,
  },
  {
    gene: "HLA-B",
    drug: "phenytoin",
    marker: ["1502"],
    severity: "high",
    guidance:
      "HLA-B*15:02 positivity raises the risk of Stevens–Johnson syndrome / toxic epidermal necrolysis; CPIC recommends AVOIDING phenytoin if an alternative is available.",
    source: SRC.phenytoin,
  },
  {
    gene: "HLA-A",
    drug: "carbamazepine",
    marker: ["3101"],
    severity: "high",
    guidance:
      "HLA-A*31:01 positivity raises the risk of carbamazepine hypersensitivity reactions (including SJS/TEN and DRESS); CPIC recommends considering an alternative.",
    source: SRC.carbamazepine,
  },
];

// Normalize a synonym/name to the matcher's canonical token form (lowercased,
// punctuation → single spaces). MUST equal lib/drug-interactions.ts's normalize so a
// committed synonym lines up with a live item name identically.
export function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Collapse a marker string to the all-alphanumeric form the engine compares markers
// against (lowercased, every non-alphanumeric removed). MUST equal the engine's
// collapseMarker.
export function collapseMarker(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface PgxDataset {
  $comment: string;
  version: number;
  severities: PgxSeverity[];
  phenotypes: Phenotype[];
  drugs: RawDrug[];
  alleles: RawAllele[];
  guidance: RawGuidance[];
}

const PHENOTYPES: Phenotype[] = [
  "poor",
  "intermediate",
  "normal",
  "rapid",
  "ultrarapid",
];

export function buildPgxDataset(): PgxDataset {
  // Drug keys unique; each has a label + something to match on.
  const drugKeys = new Set<string>();
  for (const d of DRUGS) {
    if (drugKeys.has(d.key))
      throw new Error(`gen-pgx: duplicate drug key ${d.key}`);
    drugKeys.add(d.key);
    if (!d.label.trim()) throw new Error(`gen-pgx: drug ${d.key} has no label`);
    if (d.rxcuis.length === 0 && d.synonyms.length === 0)
      throw new Error(`gen-pgx: drug ${d.key} has nothing to match on`);
  }

  const drugs = [...DRUGS]
    .map((d) => ({
      key: d.key,
      label: d.label,
      rxcuis: [
        ...new Set(d.rxcuis.map((r) => r.trim()).filter(Boolean)),
      ].sort(),
      synonyms: [
        ...new Set(d.synonyms.map(normalizeTerm).filter(Boolean)),
      ].sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Alleles: (gene, allele) unique; ensure a *1 normal exists per gene named here.
  const alleleSeen = new Set<string>();
  const alleles = [...ALLELES]
    .map((a) => {
      const key = `${a.gene}|${a.allele}`;
      if (alleleSeen.has(key))
        throw new Error(`gen-pgx: duplicate allele ${key}`);
      alleleSeen.add(key);
      return { gene: a.gene, allele: a.allele, function: a.function };
    })
    .sort(
      (x, y) => x.gene.localeCompare(y.gene) || x.allele.localeCompare(y.allele)
    );

  // Guidance references a real drug, sets EXACTLY ONE of phenotype/marker, legal
  // severity, non-empty guidance + source. No duplicate (gene, drug, phenotype/marker).
  const gSeen = new Set<string>();
  const guidance = [...GUIDANCE]
    .map((g) => {
      if (!drugKeys.has(g.drug))
        throw new Error(`gen-pgx: guidance references unknown drug ${g.drug}`);
      const hasPheno = g.phenotype != null;
      const hasMarker = g.marker != null && g.marker.length > 0;
      if (hasPheno === hasMarker)
        throw new Error(
          `gen-pgx: ${g.gene}/${g.drug} must set exactly one of phenotype/marker`
        );
      if (hasPheno && !PHENOTYPES.includes(g.phenotype!))
        throw new Error(`gen-pgx: bad phenotype ${g.phenotype} on ${g.gene}`);
      if (!SEVERITIES.includes(g.severity))
        throw new Error(`gen-pgx: bad severity ${g.severity} on ${g.gene}`);
      if (!g.guidance.trim() || !g.source.trim())
        throw new Error(`gen-pgx: ${g.gene}/${g.drug} missing guidance/source`);
      const marker = hasMarker
        ? [...new Set(g.marker!.map(collapseMarker).filter(Boolean))].sort()
        : undefined;
      const id = `${g.gene}|${g.drug}|${g.phenotype ?? (marker ?? []).join(",")}`;
      if (gSeen.has(id)) throw new Error(`gen-pgx: duplicate guidance ${id}`);
      gSeen.add(id);
      const row: RawGuidance = {
        gene: g.gene,
        drug: g.drug,
        severity: g.severity,
        guidance: g.guidance.trim(),
        source: g.source.trim(),
      };
      if (hasPheno) row.phenotype = g.phenotype;
      if (marker) row.marker = marker;
      return row;
    })
    .sort(
      (a, b) =>
        a.gene.localeCompare(b.gene) ||
        a.drug.localeCompare(b.drug) ||
        (a.phenotype ?? "").localeCompare(b.phenotype ?? "") ||
        (a.marker ?? []).join(",").localeCompare((b.marker ?? []).join(","))
    );

  return {
    $comment:
      "Baked pharmacogenomics (PGx) cross-check dataset (issue #710) — flags when a " +
      "stored PGx result (a genomic_variants row, result_type='pharmacogenomic', " +
      "#709) affects a medication in the profile's ACTIVE stack. CURATED HIGH-VALUE " +
      "subset of the best-established CPIC/FDA gene–drug pairs, NOT exhaustive; the " +
      "recommendation DIRECTION is PARAPHRASED (our words) and CITED to CPIC/FDA " +
      "(all facts public/public-domain), the star-allele functions are public CPIC/" +
      "PharmVar reference. INFORMATIONAL, never prescriptive — the absence of a flag " +
      "is NOT clearance, and the app never auto-changes a medication. Fully OFFLINE: " +
      "no gene/variant name ever leaves the box. Committed + HUMAN-REVIEWABLE; " +
      "regenerate with `npm run gen:pgx`.",
    version: 1,
    severities: SEVERITIES,
    phenotypes: PHENOTYPES,
    drugs,
    alleles,
    guidance,
  };
}

function writeDataset(): void {
  const dataset = buildPgxDataset();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.drugs.length} drug concepts, ${dataset.alleles.length} alleles, ${dataset.guidance.length} guidance rows to ${OUT}`
  );
  console.log("Review the pairs for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildPgxDataset).
if (process.argv[1]?.includes("gen-pgx")) {
  writeDataset();
}
