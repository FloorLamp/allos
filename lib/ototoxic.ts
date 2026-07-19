// Pure ototoxic-medication awareness cross-check (issue #717) — the hearing twin of the
// contrast (lib/contrast-safety.ts), dental (lib/dental-safety.ts), drug–drug
// (lib/drug-interactions.ts), and PGx (lib/pgx.ts) safety cross-checks. No DB, no
// network: given a profile's ACTIVE medications, it returns the matched informational
// notes — one per active medication that is a well-established ototoxic (hearing/balance-
// toxic) agent (an aminoglycoside antibiotic, platinum chemotherapy, a high-dose loop
// diuretic, a high-dose long-term salicylate, vancomycin, or quinine/related
// antimalarials), each with the required framing and a citation.
//
// The DB gather lives in lib/queries/intake/warnings.ts (getOtotoxicWarnings), which
// reads the ONE shared safety-context gather (getIntakeSafetyContext, #661 — active
// meds) and calls the pure function here, so the /medications + Supplements inline
// notices and the dismissible Upcoming finding are ALL formatters over ONE computation
// ("one question, one computation").
//
// DRUG IDENTITY (#482): ototoxic drug classes are matched by RxNorm ingredient CUI +
// synonym through the SHARED matchConceptKeysIn machinery (the same matcher the
// drug-interaction detector, PGx, and dental cross-checks use), NOT raw-name matching.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A note flags a conversation to
// have with the prescriber; it never says "stop your drug", never blocks anything, and
// the ABSENCE of a flag is NOT clearance (a curated subset; an unrecognized drug carries
// no flag). Fully OFFLINE — no medication name ever leaves the box.

import {
  OTOTOXIC_DRUG_ENTRIES,
  type OtotoxicDrugEntry,
} from "./datasets/ototoxic";
import { matchConceptKeysIn } from "./drug-interactions";
import type { SafetyMedication } from "./supplement-safety";

// The informational guardrail appended to every note (#717: never prescriptive; absence
// of a flag is not clearance).
const GUARDRAIL =
  "Informational — this is a general note about the medication class, not advice to " +
  "change anything; discuss any hearing or balance concern with your prescriber, and " +
  "the absence of a flag is not clearance.";

// The medication fields the matcher reads — the active-med shape from
// getIntakeSafetyContext plus its intake_items id (for the dedupeKey / row anchor).
export interface OtotoxicMedInput {
  id: number;
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}

// One matched note: an active medication resolves to an ototoxic drug class.
export interface OtotoxicHit {
  medId: number;
  medName: string;
  // The matched entry's stable key (never user input) — part of the dedupeKey.
  entryKey: string;
  category: OtotoxicDrugEntry["category"];
  note: string;
  citation: string;
  // The stable suppression/identity key — `ototoxic:<medId>:<entryKey>`. Keyed on the
  // med's item id (ids never recycle, names do — AGENTS.md #203) + the stable drug-class
  // entry, so a dismiss follows the specific med-and-finding and a med rename never
  // re-attaches it elsewhere.
  dedupeKey: string;
}

export function ototoxicSignalKey(medId: number, entryKey: string): string {
  return `ototoxic:${medId}:${entryKey}`;
}

// The ototoxic drug-class entries an active medication resolves to — matched by RxCUI
// ingredient + synonym through the shared machinery (#482). Returns the matched entries
// (an entry matched by more than one active med is deduped by the caller's map).
function entriesForMed(med: OtotoxicMedInput): OtotoxicDrugEntry[] {
  const keys = new Set(
    matchConceptKeysIn(
      {
        name: med.name,
        rxcui: med.rxcui,
        rxcuiIngredients: med.rxcuiIngredients ?? undefined,
      },
      OTOTOXIC_DRUG_ENTRIES
    )
  );
  return OTOTOXIC_DRUG_ENTRIES.filter((e) => keys.has(e.key));
}

// Detect every ototoxic note between the profile's active meds and the curated table.
// Each (med, entry) yields at most one hit. Deterministically ordered (med name, then
// entry key). An unrecognized medication produces nothing.
export function crossCheckOtotoxic(
  meds: readonly OtotoxicMedInput[]
): OtotoxicHit[] {
  const hits: OtotoxicHit[] = [];
  for (const med of meds) {
    for (const entry of entriesForMed(med)) {
      hits.push({
        medId: med.id,
        medName: med.name,
        entryKey: entry.key,
        category: entry.category,
        note: entry.note,
        citation: entry.source,
        dedupeKey: ototoxicSignalKey(med.id, entry.key),
      });
    }
  }
  return hits.sort(
    (a, b) =>
      a.medName.localeCompare(b.medName) || a.entryKey.localeCompare(b.entryKey)
  );
}

// The hits for a specific CANDIDATE medication (a create/edit inline notice's
// computation). The candidate is given id 0; reuses the one crossCheckOtotoxic so the
// notice can never disagree with the list. `active`-filtering is the caller's job.
export function ototoxicForCandidate(candidate: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): OtotoxicHit[] {
  if (!candidate.name.trim()) return [];
  return crossCheckOtotoxic([
    {
      id: 0,
      name: candidate.name,
      rxcui: candidate.rxcui,
      rxcuiIngredients: candidate.rxcuiIngredients ?? null,
    },
  ]);
}

// ---- Formatting (shared by every surface) ---------------------------------

// The note title: "Ototoxic medication — Gentamicin".
export function ototoxicTitle(hit: OtotoxicHit): string {
  return `Ototoxic medication — ${hit.medName}`;
}

// The informational, never-prescriptive detail: the class note, the fixed guardrail
// sentence, and the source citation.
export function ototoxicDetail(hit: OtotoxicHit): string {
  return `${hit.note} ${GUARDRAIL} Source: ${hit.citation}.`;
}

// Re-export the active-med shape so callers can build inputs without reaching two modules.
export type { SafetyMedication };
