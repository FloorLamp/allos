// Canonical encounter types (issue #1233). `encounters.type` is free display text
// taken verbatim from the source (Epic CCDs yield "Office Visit"/"ED Visit", FHIR
// whatever the coding display says) and `class_code` is the raw HL7 ActEncounterCode
// (AMB/IMP/EMER/…). Two sources describing the SAME kind of visit produce arbitrarily
// different `type` strings, and the raw class code renders as an opaque uppercase
// badge. This module is the ONE canonical axis every surface keys on — the
// identity-family convention (#482): a small curated table with an exclusion
// discipline (distinct settings stay APART — over-collapsing grants a wrong
// "was admitted"), computed from the raw columns rather than stored, so the mapping
// can improve and every existing row benefits with no backfill (the biomarkerFamily
// advantage the issue cites). Nothing here is clinical software; the codes are
// curated for personal-tracking grouping only.
//
// TWO levels, deliberately:
//   • classLabel() — a friendly DISPLAY label for the fine ActEncounterCode class
//     (AMB → "Ambulatory") shown on the list badge / detail / import review instead
//     of the raw code. Keeps every distinct class its own label.
//   • encounterKind() — a COARSE canonical bucket for filtering/grouping ("show ED
//     visits"). Folds the fine classes into a closed set of clinically-meaningful
//     kinds, refined by the preventive type code.
//
// The importers are UNCHANGED: they already store `class_code` / `code` / `type`, and
// the kind derives from those at read time. An input that maps to no kind keeps a
// defined fate — `"other"`, whose DISPLAY still shows the source's free-text `type`
// (encounterTypeDisplay), so nothing is ever silently dropped.

// Friendly labels for the HL7 v3 ActEncounterCode classes. Promoted here from the CDA
// encounters extractor (#1233) so the eClinicalWorks header-visit relabel and every
// UI badge draw from ONE table. Fine-grained on purpose (each distinct class keeps its
// own label); the coarse filter bucket is encounterKind() below.
export const ENCOUNTER_CLASS_LABELS: Record<string, string> = {
  AMB: "Ambulatory",
  IMP: "Inpatient",
  ACUTE: "Inpatient acute",
  NONAC: "Inpatient non-acute",
  EMER: "Emergency",
  FLD: "Field",
  HH: "Home health",
  OBSENC: "Observation",
  PRENC: "Pre-admission",
  SS: "Short stay",
  VR: "Virtual",
};

// A friendly display label for a raw ActEncounterCode class. Falls back to the raw
// (upper-cased) code for a class we haven't catalogued — never invents meaning —
// and null when there is no class at all.
export function classLabel(
  classCode: string | null | undefined
): string | null {
  const c = classCode?.trim();
  if (!c) return null;
  return ENCOUNTER_CLASS_LABELS[c.toUpperCase()] ?? c.toUpperCase();
}

// The visit's display string. Prefers the source's free-text `type` ("Office Visit"),
// else the canonical class label ("Ambulatory") rather than the bare "Visit" the UI
// used to fall back to, else "Visit". This centralizes the `type || "Visit"` fallback
// that was duplicated across the list, detail, timeline, and import-review surfaces.
export function encounterTypeDisplay(
  type: string | null | undefined,
  classCode: string | null | undefined
): string {
  const t = type?.trim();
  if (t) return t;
  return classLabel(classCode) ?? "Visit";
}

// The coarse canonical encounter KIND — a closed set for filtering/grouping. Distinct
// clinical settings stay apart (exclusion discipline #482): observation is NOT
// inpatient (distinct admission status), virtual is NOT ambulatory (telehealth vs
// in-person), and emergency never folds into ambulatory. `preventive` is the one
// refinement the source's type CODE states (a wellness/annual physical is billed with
// a preventive-medicine E/M code even though its class is Ambulatory). `other` is the
// defined fate for an input that maps to none — its display still shows the free-text
// `type`.
export type EncounterKind =
  | "preventive"
  | "emergency"
  | "inpatient"
  | "observation"
  | "virtual"
  | "home_health"
  | "ambulatory"
  | "other";

// Friendly labels for each canonical kind (filter chips, group headings).
export const ENCOUNTER_KIND_LABELS: Record<EncounterKind, string> = {
  preventive: "Preventive",
  emergency: "Emergency",
  inpatient: "Inpatient",
  observation: "Observation",
  virtual: "Virtual",
  home_health: "Home health",
  ambulatory: "Ambulatory",
  other: "Other",
};

// The stable order kinds surface in (chips / grouping) — clinical settings first,
// "other" last.
export const ENCOUNTER_KIND_ORDER: EncounterKind[] = [
  "preventive",
  "ambulatory",
  "emergency",
  "inpatient",
  "observation",
  "virtual",
  "home_health",
  "other",
];

// ActEncounterCode class → coarse kind. The inpatient subtypes (acute/non-acute/short
// stay) collapse to `inpatient` — they are the SAME setting at the filter level, not
// distinct assays — while observation/virtual/home-health stay their own kind. FLD and
// PRENC are left UNMAPPED (fall through to text/other): field and pre-admission are
// ambiguous filter buckets we don't invent one for.
const CLASS_KIND: Record<string, EncounterKind> = {
  AMB: "ambulatory",
  EMER: "emergency",
  IMP: "inpatient",
  ACUTE: "inpatient",
  NONAC: "inpatient",
  SS: "inpatient",
  OBSENC: "observation",
  VR: "virtual",
  HH: "home_health",
};

// Preventive-medicine E/M codes that make a visit `preventive` regardless of a
// (usually Ambulatory) class. The CPT preventive-medicine ranges the issue names
// (new-patient 99381–99387 and established 99391–99397) plus the Medicare wellness
// HCPCS (G0402 Welcome-to-Medicare, G0438/G0439 Annual Wellness Visit). Curated and
// EXACT (#482 discipline) — a diagnostic office-visit E/M (99201–99215) is NOT in the
// set, so it stays `ambulatory` and never falsely reads as a completed wellness visit.
// Matched by the code VALUE (system labels vary across CCDs; these codes are
// unambiguous). Mirrors the visit-rule CPT sets lib/preventive-concept-map.ts curates.
function isPreventiveEncounterCode(code: string | null | undefined): boolean {
  const c = code?.trim().toUpperCase();
  if (!c) return false;
  if (/^9938[1-7]$/.test(c)) return true; // CPT preventive-medicine, new patient
  if (/^9939[1-7]$/.test(c)) return true; // CPT preventive-medicine, established
  return c === "G0402" || c === "G0438" || c === "G0439"; // Medicare wellness
}

// Conservative whole-word keyword classification from the free-text `type` — the LAST
// resort, used ONLY when neither a class nor a preventive code decided the kind (a
// manual entry, or an AI-extracted row that carried no coding). Whole-word by design
// (#482) so "physical" in "physical therapy" never reads as a wellness physical, and
// nothing here fabricates a preventive-satisfying match beyond an explicit wellness
// phrase. Unmatched → null (the caller yields `other`).
function kindFromTypeText(
  type: string | null | undefined
): EncounterKind | null {
  const t = type?.trim().toLowerCase();
  if (!t) return null;
  if (/\bemergency\b|\be\.?d\.? visit\b/.test(t)) return "emergency";
  if (/\binpatient\b|\bhospital admission\b/.test(t)) return "inpatient";
  if (/\bobservation\b/.test(t)) return "observation";
  if (/\b(telehealth|telemedicine|virtual visit|video visit)\b/.test(t))
    return "virtual";
  if (/\bhome (?:health|visit|care)\b/.test(t)) return "home_health";
  if (
    /\b(wellness|preventive|preventative|annual physical|annual exam|annual wellness|well[-\s]?child|well[-\s]?woman)\b/.test(
      t
    )
  )
    return "preventive";
  if (/\b(office visit|outpatient|clinic visit|follow[-\s]?up)\b/.test(t))
    return "ambulatory";
  return null;
}

// The ONE canonical encounter-kind function (#221/#482): every surface (list filter,
// timeline, grouping) keys on this, never on a per-surface string match. Precedence:
//   1. A STRONG setting class (emergency / inpatient / observation / virtual /
//      home-health) dominates — an ED or inpatient visit is that kind whatever code
//      it also carries (so an EMER visit with a stray preventive code stays emergency).
//   2. An ambulatory setting (or no class) refined by a preventive-medicine code →
//      preventive.
//   3. The ambulatory setting itself → ambulatory.
//   4. No class → conservative whole-word type-text keywords.
//   5. Otherwise → other (display keeps the free-text type).
export function encounterKind(input: {
  classCode?: string | null;
  code?: string | null;
  codeSystem?: string | null;
  type?: string | null;
}): EncounterKind {
  const cls = input.classCode?.trim().toUpperCase();
  const settingKind = cls ? CLASS_KIND[cls] : undefined;
  // Strong settings dominate; the ambulatory setting stays open to preventive refinement.
  if (settingKind && settingKind !== "ambulatory") return settingKind;
  if (isPreventiveEncounterCode(input.code)) return "preventive";
  if (settingKind) return settingKind; // ambulatory
  const fromText = kindFromTypeText(input.type);
  if (fromText) return fromText;
  return "other";
}
