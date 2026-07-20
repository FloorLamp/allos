// Pre-generate the baked drug-allergy class / cross-reactivity dataset
// (lib/datasets/data/drug-allergy.json), used by the drug-allergy × medication-stack
// cross-check (issue #1029) — the allergy twin of the ototoxic (gen-ototoxic.ts),
// dental (gen-dental-safety.ts), drug–drug (gen-drug-interactions.ts), and PGx
// (gen-pgx.ts) safety cross-checks.
//
// WHAT THE DATASET IS FOR. A DIRECT ingredient match ("penicillin" allergy × a
// penicillin V med) needs NO dataset entry — the domain matcher (lib/drug-allergy.ts)
// resolves it by RxNorm code / name containment. This dataset exists for the two
// CLASS-level questions a bare name can't answer:
//   • SAME-CLASS membership — a "penicillin" allergy and an amoxicillin med are
//     different names but one drug class; the class entry's synonym set collapses them.
//   • CROSS-CLASS reactivity — the small set of class PAIRS where allergy
//     cross-reactivity is well documented (penicillins ↔ cephalosporins, aspirin ↔
//     other COX-1 NSAIDs), each with the modern, low-rate framing and a citation.
//
// EXCLUSION DISCIPLINE (#482 / the biomarkerFamily precedent): only well-documented
// classes and pairs are listed; ABSENCE OF AN ENTRY MEANS NO CLAIM, never "safe".
// Deliberately excluded:
//   • NON-antibiotic sulfonamides (furosemide, hydrochlorothiazide, celecoxib as a
//     sulfonamide, sumatriptan…) — the evidence does NOT support cross-reactivity with
//     sulfonamide ANTIBIOTIC allergy (Strom et al., NEJM 2003), so listing them would
//     manufacture false alarms. The sulfonamide class here is the ANTIBIOTIC family.
//   • Carbapenem/monobactam ↔ penicillin pairs — modern data show very low
//     cross-reactivity and the framing is contested; no entry, no claim.
//
// SOURCING / LICENSE: a small CURATED table, NOT an exhaustive allergy reference. The
// uncopyrightable clinical FACTS (class membership; documented cross-reactivity) are
// stated in our own words and CITED to public guidance (AAAAI / CDC / the joint
// AAAAI-ACAAI Drug Allergy Practice Parameter). Drug generic/brand names are public
// nomenclature.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A hit flags a conversation
// with the prescriber/pharmacist ("X is on file as an allergy — discuss"), never
// "stop taking X" — a clinician-reviewed, deliberately-continued med (a challenged /
// tolerated drug) is the common real-world case, which is why the finding is
// dismissible. Fully OFFLINE — no medication or allergen name ever leaves the box.
//
// GENERATION: mirrors gen-ototoxic.ts — the curated constants below are the SOURCE OF
// TRUTH, the JSON is GENERATED from them and COMMITTED, never hand-edited. Edit the
// tables below and re-run:
//
//   npm run gen:drug-allergy
//
// The committed lib/datasets/data/drug-allergy.json is a FIXED POINT of
// buildDrugAllergyDataset() (guarded by lib/__tests__/drug-allergy-dataset.test.ts) so
// the generator and the file can't silently diverge. Emitted with
// `JSON.stringify(dataset, null, 2)`, matching Prettier's JSON formatting.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "drug-allergy.json"
);

// One framework entry: a drug-CLASS concept the cross-check resolves allergens AND
// active meds to, matched by RxNorm ingredient CUI + synonym (the shared
// matchConceptKeysIn machinery, #482). Structurally a superset of drug-interactions'
// `Concept` ({key,label,rxcuis,synonyms}) so it feeds that matcher directly;
// `note`/`source` are the same-class finding copy.
export interface DrugAllergyClassEntry {
  key: string;
  label: string;
  rxcuis: string[];
  synonyms: string[];
  // The same-class fact, stated in our own words (the finding copy's clinical line).
  note: string;
  source: string;
}

// One documented cross-class reactivity rule (unordered pair of class keys) — the
// "possible cross-reactivity" framing plus its citation.
export interface DrugAllergyCrossRule {
  a: string;
  b: string;
  note: string;
  source: string;
}

// Dataset-level metadata: the schema version + the cross-class rules (rules are meta,
// not entries, mirroring how drug-interactions keeps its concept vocabulary in meta —
// the ENTRIES are the identity-carrying classes).
export interface DrugAllergyMeta {
  version: number;
  crossReactivity: DrugAllergyCrossRule[];
}

export type DrugAllergyDataset = DatasetEnvelope<
  DrugAllergyClassEntry,
  DrugAllergyMeta
>;

// Normalize a synonym for storage + matching: lowercased, non-alphanumerics collapsed
// to single spaces, trimmed — the SAME normalization the drug-interaction matcher uses.
export function normalizeSynonym(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function norm(list: string[]): string[] {
  return [...new Set(list.map(normalizeSynonym))].filter(Boolean).sort();
}

const AAAAI_PCN =
  "AAAAI — Penicillin Allergy: Frequently Asked Questions; CDC — Evaluation and Diagnosis of Penicillin Allergy";
const PRACTICE_PARAM =
  "Drug Allergy: An Updated Practice Parameter (AAAAI/ACAAI Joint Task Force, 2022)";
const AAAAI_ASA = "AAAAI — Aspirin-Exacerbated Respiratory Disease (AERD)";

const CLASSES: DrugAllergyClassEntry[] = [
  {
    key: "penicillins",
    label: "penicillin-class antibiotics",
    rxcuis: [],
    synonyms: [
      "penicillin",
      "penicillins",
      "penicillin v",
      "penicillin vk",
      "penicillin v potassium",
      "penicillin g",
      "benzathine penicillin",
      "bicillin",
      "amoxicillin",
      "amoxil",
      "augmentin",
      "amoxicillin clavulanate",
      "amoxicillin clavulanic acid",
      "ampicillin",
      "ampicillin sulbactam",
      "unasyn",
      "dicloxacillin",
      "nafcillin",
      "oxacillin",
      "piperacillin",
      "piperacillin tazobactam",
      "zosyn",
    ],
    note: "is a penicillin-class antibiotic — the same drug class as the recorded allergen.",
    source: AAAAI_PCN,
  },
  {
    key: "cephalosporins",
    label: "cephalosporin antibiotics",
    rxcuis: [],
    synonyms: [
      "cephalosporin",
      "cephalosporins",
      "cephalexin",
      "keflex",
      "cefadroxil",
      "cefazolin",
      "ancef",
      "cefuroxime",
      "ceftin",
      "cefprozil",
      "cefaclor",
      "cefdinir",
      "omnicef",
      "cefixime",
      "suprax",
      "cefpodoxime",
      "ceftriaxone",
      "rocephin",
      "cefotaxime",
      "ceftazidime",
      "cefepime",
    ],
    note: "is a cephalosporin antibiotic — the same drug class as the recorded allergen.",
    source: PRACTICE_PARAM,
  },
  {
    key: "sulfonamide_antibiotics",
    label: "sulfonamide (sulfa) antibiotics",
    rxcuis: [],
    synonyms: [
      "sulfa",
      "sulfa drugs",
      "sulfa antibiotics",
      "sulfonamide",
      "sulfonamides",
      "sulfamethoxazole",
      "sulfamethoxazole trimethoprim",
      "trimethoprim sulfamethoxazole",
      "bactrim",
      "septra",
      "co trimoxazole",
      "cotrimoxazole",
      "smx tmp",
      "sulfadiazine",
      "silver sulfadiazine",
      "silvadene",
      "sulfisoxazole",
      "sulfacetamide",
      "sulfasalazine",
    ],
    note: "is a sulfonamide (sulfa) antibiotic — the same drug class as the recorded allergen. (Non-antibiotic sulfonamides like furosemide or hydrochlorothiazide are a different family and are deliberately not flagged.)",
    source: PRACTICE_PARAM,
  },
  {
    key: "nsaids",
    label: "NSAIDs (non-steroidal anti-inflammatory drugs)",
    rxcuis: [],
    synonyms: [
      "nsaid",
      "nsaids",
      "ibuprofen",
      "advil",
      "motrin",
      "naproxen",
      "naproxen sodium",
      "aleve",
      "naprosyn",
      "diclofenac",
      "voltaren",
      "indomethacin",
      "indocin",
      "ketorolac",
      "toradol",
      "meloxicam",
      "mobic",
      "piroxicam",
      "feldene",
      "etodolac",
      "ketoprofen",
      "oxaprozin",
      "nabumetone",
      "sulindac",
      "flurbiprofen",
      "celecoxib",
      "celebrex",
    ],
    note: "is an NSAID — the same drug class as the recorded allergen. NSAID hypersensitivity is often class-wide (COX-1-mediated) rather than specific to one drug.",
    source: AAAAI_ASA,
  },
  {
    key: "aspirin",
    label: "aspirin (salicylates)",
    rxcuis: [],
    synonyms: ["aspirin", "acetylsalicylic acid", "asa", "excedrin"],
    note: "contains aspirin (a salicylate) — the same drug as the recorded allergen.",
    source: AAAAI_ASA,
  },
];

const CROSS_RULES: DrugAllergyCrossRule[] = [
  {
    a: "penicillins",
    b: "cephalosporins",
    note: "Penicillins and cephalosporins show possible cross-reactivity in a small share of penicillin-allergic people — modern estimates are low (about 2% overall) and depend on side-chain similarity, but the history is worth flagging before a course.",
    source: `${AAAAI_PCN}; ${PRACTICE_PARAM}`,
  },
  {
    a: "aspirin",
    b: "nsaids",
    note: "People with aspirin hypersensitivity often react to other COX-1-inhibiting NSAIDs (cross-reactive NSAID hypersensitivity), so an NSAID alongside a recorded aspirin allergy — or the reverse — is worth flagging.",
    source: AAAAI_ASA,
  },
];

export function buildDrugAllergyDataset(): DrugAllergyDataset {
  const classes: DrugAllergyClassEntry[] = CLASSES.map((c) => ({
    key: c.key,
    label: c.label,
    rxcuis: [...new Set(c.rxcuis)].sort(),
    synonyms: norm(c.synonyms),
    note: c.note,
    source: c.source,
  })).sort((a, b) => a.key.localeCompare(b.key));

  const knownKeys = new Set(classes.map((c) => c.key));
  for (const r of CROSS_RULES) {
    if (!knownKeys.has(r.a) || !knownKeys.has(r.b)) {
      throw new Error(`cross rule references an unknown class: ${r.a}|${r.b}`);
    }
  }
  const crossReactivity = CROSS_RULES.map((r) => ({
    // Store the pair sorted so the rule is direction-independent on disk.
    a: r.a <= r.b ? r.a : r.b,
    b: r.a <= r.b ? r.b : r.a,
    note: r.note,
    source: r.source,
  })).sort((x, y) => `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`));

  return {
    $schema: DATASET_SCHEMA,
    id: "drug-allergy",
    title: "Drug-allergy class / cross-reactivity",
    description:
      "Baked drug-allergy class dataset (issue #1029) — resolves recorded drug " +
      "allergens AND active medications to a small set of well-documented drug-class " +
      "families (penicillins, cephalosporins, sulfonamide ANTIBIOTICS, NSAIDs, " +
      "aspirin) for the allergy × medication-stack cross-check, plus the documented " +
      "cross-class reactivity pairs (penicillins ↔ cephalosporins with the modern " +
      "low-rate framing; aspirin ↔ COX-1 NSAIDs). Matched by RxNorm ingredient CUI + " +
      "synonym (the shared machinery). EXCLUSION-DISCIPLINED: absence of an entry is " +
      "no claim — non-antibiotic sulfonamides and carbapenem pairs are deliberately " +
      "excluded. INFORMATIONAL, never prescriptive — a hit says discuss with your " +
      "prescriber/pharmacist, never stop a medication, and the absence of a flag is " +
      "NOT clearance (a curated subset). Fully OFFLINE. Committed + HUMAN-REVIEWABLE; " +
      "regenerate with `npm run gen:drug-allergy`.",
    citation: [
      {
        source: "AAAAI — Penicillin Allergy: Frequently Asked Questions",
        url: "https://www.aaaai.org/tools-for-the-public/conditions-library/allergies/penicillin-allergy-faq",
        note: "Class membership + the modern low-rate cephalosporin cross-reactivity framing, stated in our own words. Drug names are public nomenclature.",
      },
      {
        source:
          "CDC — Evaluation and Diagnosis of Penicillin Allergy for Healthcare Professionals",
        url: "https://www.cdc.gov/antibiotic-use/hcp/clinical-signs/penicillin-allergy.html",
        note: "Public-domain US federal guidance on penicillin-allergy evaluation; the informational (never prescriptive) posture mirrors its discuss-and-verify framing.",
      },
      {
        source:
          "Drug Allergy: An Updated Practice Parameter (AAAAI/ACAAI Joint Task Force, 2022)",
        url: "https://www.aaaai.org/practice-resources/statements-and-practice-parameters/practice-parameters-and-other-guidelines",
        note: "Sulfonamide-antibiotic family scope (non-antibiotic sulfonamides excluded per the evidence) and cross-reactivity facts, stated in our own words.",
      },
      {
        source: "AAAAI — Aspirin-Exacerbated Respiratory Disease (AERD)",
        url: "https://www.aaaai.org/conditions-treatments/related-conditions/aspirin-exacerbated-respiratory-disease",
        note: "Cross-reactive COX-1 NSAID hypersensitivity facts, stated in our own words.",
      },
    ],
    identity: { keys: ["key"] },
    meta: { version: 1, crossReactivity },
    entries: classes,
  };
}

function writeDataset(): void {
  const dataset = buildDrugAllergyDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} drug-allergy classes + ` +
      `${dataset.meta?.crossReactivity.length ?? 0} cross rules to ${OUT}`
  );
  console.log("Review the table for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildDrugAllergyDataset).
if (process.argv[1]?.includes("gen-drug-allergy")) {
  writeDataset();
}
