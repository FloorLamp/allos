// Pre-generate the baked ototoxic-medication awareness dataset
// (lib/datasets/data/ototoxic.json), used to surface a calm, informational note when
// an ACTIVE medication is a well-established ototoxic agent (issue #717) — the hearing
// twin of the contrast (gen-contrast-safety.ts), dental (gen-dental-safety.ts),
// drug–drug (gen-drug-interactions.ts), and pharmacogenomics (gen-pgx.ts) safety
// cross-checks.
//
// The curated, CITED drug classes (a small, high-consequence, well-established subset —
// NOT exhaustive):
//   • AMINOGLYCOSIDE antibiotics (gentamicin, tobramycin, amikacin, streptomycin,
//     neomycin, …) — cochleotoxic and vestibulotoxic; effects can be permanent.
//   • PLATINUM chemotherapy (cisplatin, carboplatin) — cisplatin is strongly, often
//     permanently cochleotoxic; carboplatin less so.
//   • Loop DIURETICS at high / rapid IV doses (furosemide, bumetanide, torsemide,
//     ethacrynic acid) — usually reversible; risk rises alongside an aminoglycoside.
//   • High-dose, long-term SALICYLATES (aspirin) — dose-related tinnitus / hearing
//     loss that is typically reversible on stopping.
//   • VANCOMYCIN (a glycopeptide) — ototoxicity risk, especially with an aminoglycoside.
//   • QUININE and related antimalarials (chloroquine, hydroxychloroquine) — cinchonism
//     (reversible) with quinine; rare irreversible loss with the others.
//
// SOURCING / LICENSE: small CURATED table, NOT an exhaustive reference. The
// uncopyrightable clinical FACTS (this drug class is ototoxic) are stated in our own
// words and CITED to their public source; drug generic/brand names are public
// nomenclature.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A note flags a conversation to
// have with the prescriber — it never says "stop your drug", never blocks anything, and
// the ABSENCE of a flag is NOT clearance (a curated subset; an unrecognized drug carries
// no flag). Fully OFFLINE — the curated table is baked here and shipped in the repo; no
// medication name is ever sent to any external API.
//
// GENERATION: mirrors gen-dental-safety.ts — the curated constants below are the SOURCE
// OF TRUTH, the JSON is GENERATED from them and COMMITTED, and is never hand-edited.
// Edit the table below and re-run:
//
//   npm run gen:ototoxic
//
// The committed lib/datasets/data/ototoxic.json is a FIXED POINT of
// buildOtotoxicDataset() (guarded by lib/__tests__/ototoxic-dataset.test.ts) so the
// generator and the file can't silently diverge. Emitted with
// `JSON.stringify(dataset, null, 2)`, matching Prettier's JSON formatting.

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "ototoxic.json"
);

export type OtotoxicCategory =
  | "aminoglycoside"
  | "platinum-chemo"
  | "loop-diuretic"
  | "salicylate"
  | "glycopeptide"
  | "antimalarial";

// One framework entry: a DRUG concept the cross-check detects in the active stack,
// matched by RxNorm ingredient CUI + synonym (the shared matchConceptKeysIn machinery,
// #482). Structurally a superset of drug-interactions' `Concept` ({key,label,rxcuis,
// synonyms}) so it feeds that matcher directly; `category` groups the class and
// `note`/`source` are the finding copy.
export interface OtotoxicDrugEntry {
  key: string;
  category: OtotoxicCategory;
  label: string;
  rxcuis: string[];
  synonyms: string[];
  note: string;
  source: string;
}

// Dataset-level metadata that ISN'T a per-drug entry: the schema version.
export interface OtotoxicMeta {
  version: number;
}

export type OtotoxicDataset = DatasetEnvelope<OtotoxicDrugEntry, OtotoxicMeta>;

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

const ASHA =
  "American Speech-Language-Hearing Association — Ototoxic Medications";
const NIDCD =
  "NIH NIDCD; American Speech-Language-Hearing Association — Ototoxic Medications";

// The GUARDRAIL suffix belongs to the DOMAIN layer (lib/ototoxic.ts), NOT the note here,
// so the note is just the class-specific clinical fact stated in our own words.
const DRUGS: OtotoxicDrugEntry[] = [
  {
    key: "aminoglycoside",
    category: "aminoglycoside",
    label: "Aminoglycoside antibiotics (gentamicin, tobramycin, amikacin)",
    rxcuis: [],
    synonyms: [
      "gentamicin",
      "garamycin",
      "tobramycin",
      "tobrex",
      "amikacin",
      "amikin",
      "streptomycin",
      "neomycin",
      "kanamycin",
      "paromomycin",
      "plazomicin",
      "aminoglycoside",
    ],
    note: "This is an aminoglycoside antibiotic, a class that can be toxic to the inner ear (hearing and balance) — sometimes permanently. Hearing/balance monitoring is sometimes advised during a course.",
    source: ASHA,
  },
  {
    key: "platinum_chemo",
    category: "platinum-chemo",
    label: "Platinum chemotherapy (cisplatin, carboplatin)",
    rxcuis: [],
    synonyms: ["cisplatin", "platinol", "carboplatin", "paraplatin"],
    note: "This is a platinum-based chemotherapy; cisplatin in particular is strongly toxic to hearing, and the loss can be permanent. Hearing is often monitored during treatment.",
    source: ASHA,
  },
  {
    key: "loop_diuretic",
    category: "loop-diuretic",
    label: "Loop diuretics (furosemide, bumetanide, ethacrynic acid)",
    rxcuis: [],
    synonyms: [
      "furosemide",
      "lasix",
      "bumetanide",
      "bumex",
      "torsemide",
      "torasemide",
      "demadex",
      "ethacrynic acid",
      "edecrin",
    ],
    note: "This is a loop diuretic; at high or rapid intravenous doses it can affect hearing (usually reversibly), and the risk rises if it is taken alongside an aminoglycoside antibiotic.",
    source: NIDCD,
  },
  {
    key: "salicylate",
    category: "salicylate",
    label: "Salicylates (high-dose aspirin)",
    rxcuis: [],
    synonyms: [
      "aspirin",
      "acetylsalicylic acid",
      "asa",
      "salicylate",
      "salsalate",
    ],
    note: "At HIGH doses taken over time, salicylates (aspirin) can cause ringing in the ears or temporary hearing loss that typically reverses when the dose is lowered or stopped. Low-dose (cardioprotective) aspirin is not generally implicated.",
    source: NIDCD,
  },
  {
    key: "vancomycin",
    category: "glycopeptide",
    label: "Vancomycin",
    rxcuis: [],
    synonyms: ["vancomycin", "vancocin"],
    note: "Vancomycin (a glycopeptide antibiotic) carries a risk of hearing effects, especially at high levels or when combined with an aminoglycoside; drug levels and hearing are sometimes monitored.",
    source: NIDCD,
  },
  {
    key: "quinine_antimalarial",
    category: "antimalarial",
    label: "Quinine and related antimalarials",
    rxcuis: [],
    synonyms: [
      "quinine",
      "qualaquin",
      "chloroquine",
      "hydroxychloroquine",
      "plaquenil",
    ],
    note: "Quinine and related antimalarials can cause ringing in the ears and hearing loss; with quinine this is usually reversible, while the others rarely cause lasting loss.",
    source: NIDCD,
  },
];

export function buildOtotoxicDataset(): OtotoxicDataset {
  const drugs: OtotoxicDrugEntry[] = DRUGS.map((d) => ({
    key: d.key,
    category: d.category,
    label: d.label,
    rxcuis: [...new Set(d.rxcuis)].sort(),
    synonyms: norm(d.synonyms),
    note: d.note,
    source: d.source,
  })).sort((a, b) => a.key.localeCompare(b.key));

  return {
    $schema: DATASET_SCHEMA,
    id: "ototoxic",
    title: "Ototoxic-medication awareness",
    description:
      "Baked ototoxic-medication awareness dataset (issue #717) — surfaces a calm, " +
      "informational note when an ACTIVE medication is a well-established ototoxic " +
      "(hearing/balance-toxic) agent: an AMINOGLYCOSIDE antibiotic, PLATINUM " +
      "chemotherapy (cisplatin/carboplatin), a high-dose loop DIURETIC, a high-dose " +
      "long-term SALICYLATE (aspirin), VANCOMYCIN, or QUININE / related antimalarials. " +
      "Drugs match by RxNorm ingredient CUI + synonym (the shared machinery). " +
      "INFORMATIONAL, never prescriptive — it never says stop a drug, never blocks " +
      "anything, and the absence of a flag is NOT clearance (a curated subset). Fully " +
      "OFFLINE. Committed + HUMAN-REVIEWABLE; regenerate with `npm run gen:ototoxic`.",
    citation: [
      {
        source: ASHA,
        url: "https://www.asha.org/public/hearing/ototoxic-medications/",
        note: "Uncopyrightable clinical facts (these drug classes are ototoxic) stated in our own words and cited to the ASHA consumer reference. Drug generic/brand names are public nomenclature.",
      },
      {
        source: "NIH NIDCD — Hearing, Ear Infections, and Deafness",
        url: "https://www.nidcd.nih.gov/health/hearing-ear-infections-deafness",
        note: "General NIH reference on hearing loss causes including medication-related (ototoxic) loss, stated in our own words.",
      },
    ],
    identity: { keys: ["key"] },
    meta: { version: 1 },
    entries: drugs,
  };
}

function writeDataset(): void {
  const dataset = buildOtotoxicDataset();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} ototoxic drug entries to ${OUT}`
  );
  console.log("Review the table for plausibility before committing.");
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildOtotoxicDataset).
if (process.argv[1]?.includes("gen-ototoxic")) {
  writeDataset();
}
