// Pure dental-procedure safety cross-check (issue #704) — the dental twin of the
// contrast (lib/contrast-safety.ts), drug–drug (lib/drug-interactions.ts), and PGx
// (lib/pgx.ts) safety cross-checks. No DB, no network: given a profile's PLANNED
// INVASIVE dental procedures (status='planned' dental_procedures rows that are
// bone-manipulating / bleeding-prone, #705) and its active medications + active
// conditions, it returns the matched pre-procedure notes — an ANTIRESORPTIVE → MRONJ
// caution, a high-risk CARDIAC condition → antibiotic-prophylaxis note, or an
// ANTICOAGULANT → bleeding note — each with the required framing and a guideline
// citation.
//
// The DB gather lives in lib/queries/intake/warnings.ts (getDentalSafetyWarnings),
// which reads the profile's planned invasive dental procedures + the ONE shared
// safety-context gather (getIntakeSafetyContext, #661 — active meds + conditions) and
// calls the pure functions here, so any future inline notice and the dismissible
// Upcoming finding are BOTH formatters over ONE computation ("one question, one
// computation").
//
// PLANNED-PROCEDURE SIGNAL (#704 ask 1 + ask 4): the trigger is a status='planned'
// dental_procedures row that isInvasiveDentalProcedure (extraction / implant / bony or
// periodontal surgery — lib/dental). A routine cleaning / exam / filling is NOT
// invasive and triggers NOTHING (the gate the DB test pins). The gather does the
// invasiveness filter; this engine cross-checks whatever planned procedures it's given.
//
// DRUG IDENTITY (#482): antiresorptives / anticoagulants are matched by RxNorm
// ingredient CUI + synonym through the SHARED matchConceptKeysIn machinery (the same
// matcher the drug-interaction detector and PGx cross-check use), NOT raw-name
// matching. Cardiac conditions are matched by curated keyword (there is no coded
// cardiac-risk recognizer).
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A note flags a conversation to
// have with the dentist / prescriber; it never says "stop your drug" / "you need
// antibiotics", never blocks a procedure, and the ABSENCE of a flag is NOT clearance
// (a curated subset; an unrecognized drug/condition carries no flag). Fully OFFLINE.

import {
  conditionCodeConcepts,
  conditionInputName,
  type ConditionConcept,
  type ConditionInput,
} from "./condition-codes";
import {
  DENTAL_DRUG_ENTRIES,
  DENTAL_CONDITION_GATES,
  type DentalDrugEntry,
  type DentalConditionGate,
} from "./datasets/dental-safety";
import { matchConceptKeysIn } from "./drug-interactions";
import type { SafetyMedication } from "./supplement-safety";

// The three gate families a note belongs to (#704). `antiresorptive`/`anticoagulant`
// are DRUG gates; `cardiac` is the condition (antibiotic-prophylaxis) gate.
export type DentalGate = "antiresorptive" | "anticoagulant" | "cardiac";

// The informational guardrail appended to every note (#704 ask 3: never prescriptive;
// absence of a flag is not clearance).
const GUARDRAIL =
  "Informational — this flags a conversation to have with your dentist and " +
  "prescriber; it does not tell you to change any treatment, and the absence of a " +
  "flag is not clearance.";

// A planned invasive dental procedure the gather passes in (already invasiveness-
// filtered). `label` is the display string; `id` anchors the finding's dedupeKey.
export interface PlannedDentalProcedure {
  id: number;
  label: string;
  date: string | null;
}

// One matched note: a planned invasive procedure meets a drug or condition gate.
export interface DentalSafetyHit {
  procedureId: number;
  procedureLabel: string;
  gate: DentalGate;
  // The gate's stable key (drug-entry key or condition-gate key) — part of the
  // dedupeKey and never user input.
  gateKey: string;
  // The med name or condition phrase that matched (display context).
  matchedOn: string;
  note: string;
  citation: string;
  // The stable suppression/identity key — `dental-safety:<procedureId>:<gateKey>`.
  // Keyed on the procedure ROW id (ids never recycle — AGENTS.md #203) + the gate, so
  // a dismiss follows the specific procedure-and-finding and doesn't drift.
  dedupeKey: string;
}

function normalize(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function dentalSafetySignalKey(
  procedureId: number,
  gateKey: string
): string {
  return `dental-safety:${procedureId}:${gateKey}`;
}

// The coded half of the cardiac condition gates (#1030): which curated code
// CONCEPTS (lib/condition-codes — ICD-10 Z95.2x prosthetic valve, I33
// endocarditis, the cyanotic-CHD lesions, Z94.1 transplant status) satisfy which
// dataset gate key. Consulted code-first with the keyword match as the name
// fallback, so a coded row with a terse label ("AVR" as Z95.2) reaches the
// antibiotic-prophylaxis note. Keys must exist in DENTAL_CONDITION_GATES —
// pinned by a pure test so a dataset rename can't silently orphan the mapping.
export const DENTAL_GATE_CONCEPTS: Record<string, ConditionConcept[]> = {
  prosthetic_valve: ["prosthetic-heart-valve"],
  prior_endocarditis: ["infective-endocarditis"],
  congenital_heart_disease: ["high-risk-congenital-heart-disease"],
  cardiac_transplant_valvulopathy: ["cardiac-transplant"],
};

// Whether a condition satisfies a gate: its stored CODE first (the curated
// concept mapping above), else ANY keyword appears as a substring of the
// normalized name (keywords are already normalized). Substring (not token-set)
// is fine here: the keywords are multi-word specific phrases ("prosthetic heart
// valve", "infective endocarditis") whose presence is the signal.
function conditionMatchesGate(
  condition: ConditionInput,
  conditionNorm: string,
  gate: DentalConditionGate
): boolean {
  const concepts = conditionCodeConcepts(condition);
  if (
    concepts.size > 0 &&
    (DENTAL_GATE_CONCEPTS[gate.key] ?? []).some((c) => concepts.has(c))
  ) {
    return true;
  }
  return gate.keywords.some((kw) => conditionNorm.includes(kw));
}

// The drug entries an active medication resolves to — matched by RxCUI ingredient +
// synonym through the shared machinery (#482). A single med can match more than one
// entry only if the tables overlapped (they don't); returns the matched entries.
function drugEntriesForMed(med: SafetyMedication): DentalDrugEntry[] {
  const keys = new Set(
    matchConceptKeysIn(
      {
        name: med.name,
        rxcui: med.rxcui,
        rxcuiIngredients: med.rxcuiIngredients ?? undefined,
      },
      DENTAL_DRUG_ENTRIES
    )
  );
  return DENTAL_DRUG_ENTRIES.filter((e) => keys.has(e.key));
}

// Detect every dental-safety note between the profile's planned invasive procedures
// and its active meds + conditions. Each (procedure, gate) yields at most one hit — a
// gate matched by more than one med/condition names the FIRST match. Deterministically
// ordered (procedure id, gate key). A routine (non-invasive) procedure never reaches
// here (the gather filters it), so it can never produce a hit.
export function crossCheckDentalSafety(
  procedures: readonly PlannedDentalProcedure[],
  meds: readonly SafetyMedication[],
  conditions: readonly ConditionInput[]
): DentalSafetyHit[] {
  if (procedures.length === 0) return [];

  // Which drug entries the active stack matches (entry key → the med name that hit).
  const drugMatch = new Map<string, { entry: DentalDrugEntry; med: string }>();
  for (const med of meds) {
    for (const entry of drugEntriesForMed(med)) {
      if (!drugMatch.has(entry.key))
        drugMatch.set(entry.key, { entry, med: med.name });
    }
  }

  // Which condition gates the active conditions match (gate key → the condition text).
  const condMatch = new Map<
    string,
    { gate: DentalConditionGate; condition: string }
  >();
  for (const condition of conditions) {
    const name = conditionInputName(condition);
    const n = normalize(name);
    if (!n && conditionCodeConcepts(condition).size === 0) continue;
    for (const gate of DENTAL_CONDITION_GATES) {
      if (!condMatch.has(gate.key) && conditionMatchesGate(condition, n, gate))
        condMatch.set(gate.key, { gate, condition: name });
    }
  }

  const hits: DentalSafetyHit[] = [];
  for (const proc of procedures) {
    for (const { entry, med } of drugMatch.values()) {
      hits.push({
        procedureId: proc.id,
        procedureLabel: proc.label,
        gate: entry.category,
        gateKey: entry.key,
        matchedOn: med,
        note: entry.note,
        citation: entry.source,
        dedupeKey: dentalSafetySignalKey(proc.id, entry.key),
      });
    }
    for (const { gate, condition } of condMatch.values()) {
      hits.push({
        procedureId: proc.id,
        procedureLabel: proc.label,
        gate: "cardiac",
        gateKey: gate.key,
        matchedOn: condition,
        note: gate.note,
        citation: gate.source,
        dedupeKey: dentalSafetySignalKey(proc.id, gate.key),
      });
    }
  }

  return hits.sort(
    (a, b) =>
      a.procedureId - b.procedureId || a.gateKey.localeCompare(b.gateKey)
  );
}

// ---- Formatting (shared by every surface) ---------------------------------

const GATE_TITLE: Record<DentalGate, string> = {
  antiresorptive: "Before dental surgery: MRONJ risk",
  anticoagulant: "Before dental surgery: bleeding",
  cardiac: "Before dental work: antibiotic prophylaxis",
};

// The note title: "Before dental surgery: MRONJ risk — Extraction · #14".
export function dentalSafetyTitle(hit: DentalSafetyHit): string {
  return `${GATE_TITLE[hit.gate]} — ${hit.procedureLabel}`;
}

// The informational, never-prescriptive detail: the gate note, the fixed guardrail
// sentence, and the guideline citation.
export function dentalSafetyDetail(hit: DentalSafetyHit): string {
  return `${hit.note} ${GUARDRAIL} Source: ${hit.citation}.`;
}
