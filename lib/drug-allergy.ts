// Pure drug-allergy × medication-stack cross-check (issue #1029) — the allergy twin
// of the ototoxic (lib/ototoxic.ts), PGx (lib/pgx.ts), and drug–drug
// (lib/drug-interactions.ts) safety cross-checks. No DB, no network: given a
// profile's NON-RESOLVED recorded drug allergies and its ACTIVE medications, it
// returns the matched informational notes — one per (allergy, medication) pair whose
// medication matches the recorded allergen directly, by drug class, or by a
// documented cross-reactive class.
//
// The DB gather lives in lib/queries/intake/warnings.ts (getDrugAllergyWarnings),
// which reads the ONE shared safety-context gather (getIntakeSafetyContext, #661 —
// non-resolved allergy records + active meds with CUIs) and calls the pure function
// here, so the /medications + Supplements safety strips and the dismissible Upcoming
// finding are ALL formatters over ONE computation ("one question, one computation").
//
// MATCHING (most-specific wins, one hit per pair):
//   1. INGREDIENT — code-first: the allergen's coded RxNorm CUI (allergies.
//      substance_code, dead weight until now) equals ANY CUI the med carries (product
//      rxcui + cached #279 ingredient CUIs); name fallback: the folded allergen
//      substance and med name token-contain each other in either direction ("penicillin"
//      × "Penicillin V Potassium 500 mg"; "Amoxicillin trihydrate" × "Amoxicillin").
//   2. CLASS — both sides resolve to the SAME curated drug-class concept
//      (lib/datasets/drug-allergy) through the shared matchConceptKeysIn machinery
//      (#482): a "penicillin" allergy and an amoxicillin med are one class.
//   3. CROSS-CLASS — the sides resolve to a documented cross-reactive PAIR
//      (penicillins ↔ cephalosporins, aspirin ↔ COX-1 NSAIDs), phrased with the
//      modern "possible cross-reactivity" low-rate framing.
// EXCLUSION-DISCIPLINED: no dataset entry / no code / no token match ⇒ NO claim.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE (#1029 ask 3): the copy is
// "X is on file as an allergy — discuss with your prescriber/pharmacist", never
// "stop taking X". The finding is bus-dismissible — a clinician-reviewed,
// deliberately-continued med (a challenged/tolerated drug) is the common real-world
// case. The check runs at SURFACE time, never blocks a write (#1029 ask 4). Absence
// of a flag is NOT clearance (a curated subset). Fully OFFLINE.

import {
  DRUG_ALLERGY_CLASSES,
  DRUG_ALLERGY_CROSS_RULES,
  type DrugAllergyClassEntry,
} from "./datasets/drug-allergy";
import {
  matchConceptKeysIn,
  itemRxcuis,
  normalizeDrugTerm,
  drugTermContains,
} from "./drug-interactions";

// The findings-bus namespace for the drug-allergy × med cross-check. Registered on
// the intake-surface dismiss guard + the Upcoming risk-layer allowlist.
export const DRUG_ALLERGY_PREFIX = "allergy-med:";

// The stable suppression/identity key — `allergy-med:<allergyId>-<itemId>`, keyed on
// the two AUTOINCREMENT row ids (ids never recycle, names do — AGENTS.md #203), so a
// dismiss follows the specific allergy-and-med pair and dies with either row.
export function drugAllergySignalKey(
  allergyId: number,
  itemId: number
): string {
  return `${DRUG_ALLERGY_PREFIX}${allergyId}-${itemId}`;
}

// A recorded (non-resolved) allergy, as the cross-check consumes it. The coded
// allergen (substance_code / substance_code_system — RxNorm for drug allergens on
// the CCDA/FHIR import paths) drives the authoritative code match.
export interface AllergyRecordInput {
  id: number;
  substance: string;
  substanceCode: string | null;
  substanceCodeSystem: string | null;
  reaction: string | null;
}

// The active-med shape the matcher reads — the safety-context med plus its
// intake_items id (for the dedupeKey / row anchor).
export interface DrugAllergyMedInput {
  id: number;
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}

export type DrugAllergyMatchKind = "ingredient" | "class" | "cross-class";

// One matched note: an active medication meets a recorded allergy.
export interface DrugAllergyHit {
  allergyId: number;
  substance: string;
  reaction: string | null;
  medId: number;
  medName: string;
  match: DrugAllergyMatchKind;
  // The clinical line for the match (the class/rule note, or the direct-match fact).
  note: string;
  source: string;
  dedupeKey: string;
}

// Whether a substance_code_system names RxNorm — the URI, the OID, or the plain
// name, matched loosely (import paths vary). A non-RxNorm code (SNOMED allergen
// concepts, local codes) is NOT compared against med CUIs — never a cross-vocabulary
// guess.
export function isRxNormCodeSystem(system: string | null): boolean {
  if (!system) return false;
  const s = system.toLowerCase();
  return s.includes("rxnorm") || s.includes("2.16.840.1.113883.6.88");
}

const DIRECT_SOURCE = "Recorded allergy in this profile's health record";

// The class entries a name/code resolves to, via the ONE shared matcher.
function classKeysFor(item: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): Set<string> {
  return new Set(matchConceptKeysIn(item, DRUG_ALLERGY_CLASSES));
}

const CLASS_BY_KEY = new Map<string, DrugAllergyClassEntry>(
  DRUG_ALLERGY_CLASSES.map((c) => [c.key, c])
);

// Rank for "most-specific wins" within one (allergy, med) pair.
const MATCH_RANK: Record<DrugAllergyMatchKind, number> = {
  ingredient: 0,
  class: 1,
  "cross-class": 2,
};

// Detect every drug-allergy note between the recorded (non-resolved) allergies and
// the active medication stack. Each (allergy, med) pair yields AT MOST ONE hit — the
// most specific matching tier. Deterministically ordered (substance, then med name,
// then ids). An unmatched pair produces nothing; an empty side produces nothing.
export function crossCheckDrugAllergies(
  allergies: readonly AllergyRecordInput[],
  meds: readonly DrugAllergyMedInput[]
): DrugAllergyHit[] {
  const hits: DrugAllergyHit[] = [];
  for (const allergy of allergies) {
    const substance = allergy.substance.trim();
    if (!substance) continue;
    const allergenNorm = normalizeDrugTerm(substance);
    const rxCode = isRxNormCodeSystem(allergy.substanceCodeSystem)
      ? (allergy.substanceCode?.trim() ?? "")
      : "";
    const allergenKeys = classKeysFor({
      name: substance,
      rxcui: rxCode || null,
    });

    for (const med of meds) {
      const medNorm = normalizeDrugTerm(med.name);
      const medCuis = itemRxcuis(med);
      const medKeys = classKeysFor(med);

      let best: {
        kind: DrugAllergyMatchKind;
        note: string;
        source: string;
      } | null = null;
      const consider = (
        kind: DrugAllergyMatchKind,
        note: string,
        source: string
      ) => {
        if (!best || MATCH_RANK[kind] < MATCH_RANK[best.kind]) {
          best = { kind, note, source };
        }
      };

      // 1. Ingredient — code-first (the allergen's RxNorm CUI against every CUI the
      //    med carries), then folded token containment in either direction.
      if (
        (rxCode && medCuis.has(rxCode)) ||
        (allergenNorm &&
          medNorm &&
          (drugTermContains(medNorm, allergenNorm) ||
            drugTermContains(allergenNorm, medNorm)))
      ) {
        consider(
          "ingredient",
          `${med.name} matches the recorded allergen directly.`,
          DIRECT_SOURCE
        );
      }

      // 2. Same class — both sides resolve to one curated class concept.
      if (!best) {
        for (const key of allergenKeys) {
          if (!medKeys.has(key)) continue;
          const entry = CLASS_BY_KEY.get(key);
          if (!entry) continue;
          consider("class", `${med.name} ${entry.note}`, entry.source);
          break;
        }
      }

      // 3. Documented cross-class reactivity (either direction of the stored pair).
      if (!best) {
        for (const rule of DRUG_ALLERGY_CROSS_RULES) {
          const covers =
            (allergenKeys.has(rule.a) && medKeys.has(rule.b)) ||
            (allergenKeys.has(rule.b) && medKeys.has(rule.a));
          if (!covers) continue;
          consider("cross-class", rule.note, rule.source);
          break;
        }
      }

      if (best) {
        const { kind, note, source } = best as {
          kind: DrugAllergyMatchKind;
          note: string;
          source: string;
        };
        hits.push({
          allergyId: allergy.id,
          substance,
          reaction: allergy.reaction?.trim() || null,
          medId: med.id,
          medName: med.name,
          match: kind,
          note,
          source,
          dedupeKey: drugAllergySignalKey(allergy.id, med.id),
        });
      }
    }
  }
  return hits.sort(
    (a, b) =>
      MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
      a.substance.localeCompare(b.substance) ||
      a.medName.localeCompare(b.medName) ||
      a.allergyId - b.allergyId ||
      a.medId - b.medId
  );
}

// ---- Formatting (shared by every surface) ---------------------------------

const MATCH_LABEL: Record<DrugAllergyMatchKind, string> = {
  ingredient: "Allergy on file",
  class: "Allergy class on file",
  "cross-class": "Possible cross-reactivity",
};

export function drugAllergyMatchLabel(hit: DrugAllergyHit): string {
  return MATCH_LABEL[hit.match];
}

// The note title: "Allergy on file — Amoxicillin × Penicillin allergy".
export function drugAllergyTitle(hit: DrugAllergyHit): string {
  return `${MATCH_LABEL[hit.match]} — ${hit.medName} × ${hit.substance} allergy`;
}

// The fact line: what's recorded and how the med matches it. Reaction (when
// recorded) rides along so "Penicillin — hives" reads as recorded.
export function drugAllergyDetail(hit: DrugAllergyHit): string {
  const recorded = hit.reaction
    ? `${hit.substance} (recorded reaction: ${hit.reaction}) is on file as an allergy.`
    : `${hit.substance} is on file as an allergy.`;
  return `${recorded} ${hit.note}`;
}

// The informational guardrail + citation tail every surface appends (#1029 ask 3:
// never prescriptive — a deliberately-continued, clinician-reviewed med is common).
export function drugAllergyEvidence(hit: DrugAllergyHit): string {
  return (
    "Informational, not medical advice — discuss with your prescriber or " +
    "pharmacist; do not stop or change a medication based on this alone, and the " +
    `absence of a flag is not clearance. Source: ${hit.source}.`
  );
}

// The self-contained secondary line for single-string surfaces (the Upcoming item).
export function drugAllergyFullDetail(hit: DrugAllergyHit): string {
  return `${drugAllergyDetail(hit)} ${drugAllergyEvidence(hit)}`;
}
