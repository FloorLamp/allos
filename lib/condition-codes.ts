// Curated condition CODE → concept recognizer (issue #1030) — the coded half of
// the condition recognizers, mirroring how the medication layer already treats
// RxCUI (authoritative code, name fallback — matchConceptKeysIn in
// lib/drug-interactions.ts). The `conditions` / `family_history` tables store
// `code` + `code_system` alongside the verbatim name, but every recognizer
// (risk factors, the dental cardiac gate, the condition→nutrient rules) matched
// on the NAME only — so a condition imported with code E11.9 but a terse name
// ("DM2") silently dropped out of every gate, always in the false-negative
// direction. This module makes the stored codes count.
//
// #482 identity-family discipline:
//   • ONE pure matcher (conditionCodeConcepts) that every consumer keys on —
//     conditionsToRiskFactors, the dental condition gates, and the
//     condition→nutrient rules all resolve codes THROUGH here, never with a
//     bespoke second parse.
//   • EXCLUSION-DISCIPLINED and cited: only unambiguous, well-established code
//     families get entries. No entry ⇒ the consumer falls through to today's
//     name/stem behavior — never a guess. Over-collapsing would grant wrong
//     matches, so ambiguous vocabularies (ICD-9, LOINC, CPT) never code-match.
//   • Per-concept code-first with name fallback, UNIONED across concepts —
//     exactly the matchConceptKeysIn shape ("both are collected so a mislabeled
//     row still matches on whichever signal fits"). A per-ROW "code suppresses
//     stem" rule would REGRESS combination rows (ICD-10 E11.21 "diabetes with
//     nephropathy" codes only the diabetes family while the name carries the
//     kidney stem), which is the false-negative disease this fixes.
//
// This is a RECALL hardening, not a canonical-vocabulary project (issue #1030
// scope note): no SNOMED graph, no translation service, no storage/display
// change. Pure — no DB, no network; unit-tested in
// lib/__tests__/condition-codes.test.ts.

// A condition as its recognizers now see it: the display name plus the stored
// coded identity when the row carries one. `codeSystem` is the labeled system
// the importers store ("ICD-10-CM", "SNOMED CT", …) — see codeSystemLabel
// (CDA) / systemLabel (FHIR).
export interface CodedConditionRef {
  name: string;
  code?: string | null;
  codeSystem?: string | null;
}

// What every widened recognizer accepts: a bare name (manual/legacy callers and
// tests keep working unchanged) or the coded ref.
export type ConditionInput = string | CodedConditionRef;

// The display name of a condition input — what matchers stem-match and surfaces
// show ("matchedOn" context).
export function conditionInputName(c: ConditionInput): string {
  return typeof c === "string" ? c : c.name;
}

// The closed concept vocabulary the code table maps into. Consumers translate
// concepts to their own keys (RiskFactor, dental gate key, nutrient rule) — a
// new coded target adds a concept here plus its curated families below.
export type ConditionConcept =
  // Risk-stratification targets (personal conditions + family history).
  | "diabetes"
  | "hypertension"
  | "chronic-kidney-disease"
  // Contrast gadolinium/NSF gate: stage 4-5 / ESRD codes (a subset of CKD).
  | "advanced-kidney-disease"
  | "cardiovascular-disease"
  | "malignant-neoplasm"
  | "glaucoma"
  // The dental antibiotic-prophylaxis (AHA high-risk cardiac) gates.
  | "prosthetic-heart-valve"
  | "infective-endocarditis"
  | "high-risk-congenital-heart-disease"
  | "cardiac-transplant"
  // Condition→nutrient drop-rule targets (lib/condition-nutrient).
  | "hyperkalemia"
  | "hypercalcemia"
  | "wilson-disease";

// One curated code family: the ICD-10-CM prefixes (matched dot-insensitively —
// "N18.4" and "N184" are the same code) and exact SNOMED CT concept ids that
// unambiguously identify the concept. Sources are informational citations, the
// same posture as the other curated datasets (#860).
interface ConditionCodeFamily {
  concept: ConditionConcept;
  icd10Prefixes: string[];
  snomed: string[];
}

const CONDITION_CODE_FAMILIES: ConditionCodeFamily[] = [
  // Diabetes mellitus — ICD-10 E10 (type 1) / E11 (type 2); SNOMED DM +
  // type 1/type 2. (ADA classification; the issue's anchor case "DM2" + E11.9.)
  {
    concept: "diabetes",
    icd10Prefixes: ["E10", "E11"],
    snomed: ["73211009", "44054006", "46635009"],
  },
  // Hypertensive diseases — ICD-10 I10 (essential) through I13 (hypertensive
  // heart/kidney disease) + I15 (secondary); SNOMED hypertensive disorder /
  // essential hypertension. I12/I13 ALSO map to chronic-kidney-disease below —
  // a combination code legitimately activates both concepts.
  {
    concept: "hypertension",
    icd10Prefixes: ["I10", "I11", "I12", "I13", "I15"],
    snomed: ["38341003", "59621000"],
  },
  // Chronic kidney disease — ICD-10 N18 (all stages) and the hypertensive-CKD
  // combination codes I12/I13; SNOMED CKD / chronic renal failure / ESRD (KDIGO).
  {
    concept: "chronic-kidney-disease",
    icd10Prefixes: ["N18", "I12", "I13"],
    snomed: ["709044004", "90688005", "46177005"],
  },
  // ADVANCED kidney disease — the gadolinium/NSF marker the contrast gate needs
  // (stage 4, stage 5, ESRD). A subset of the CKD family above, kept separate so
  // the contrast cross-check's "advanced" recognition can be code-driven too.
  {
    concept: "advanced-kidney-disease",
    icd10Prefixes: ["N18.4", "N18.5", "N18.6"],
    snomed: ["46177005"],
  },
  // Ischemic heart disease AND cerebrovascular stroke — ICD-10 I20–I25 (ischemic
  // heart disease; the #1030 named family) PLUS I60/I61/I63/I64 (the acute stroke
  // events: subarachnoid + intracerebral hemorrhage, cerebral infarction, and
  // stroke NOS). Drives the family-cardiovascular history factor (ACC/AHA). SNOMED
  // ischemic heart disease / coronary arteriosclerosis / MI / cerebrovascular
  // accident. The stroke codes close the #1039 residual: the FAMILY_KEYWORDS stem
  // set already treats "stroke" as family-cardiovascular, but a coded-but-tersely-
  // named row ("CVA" + I63 — no "stroke" substring) matched no prefix and dropped,
  // the same code-blindness #1030 fixed for the ischemic-heart half ("MI" + I21).
  // The occlusion/stenosis-without-infarction (I65/I66) and sequelae (I67–I69)
  // codes are deliberately excluded — exclusion discipline keeps a non-event
  // cerebrovascular finding from activating the factor.
  {
    concept: "cardiovascular-disease",
    icd10Prefixes: [
      "I20",
      "I21",
      "I22",
      "I23",
      "I24",
      "I25",
      "I60",
      "I61",
      "I63",
      "I64",
    ],
    snomed: ["414545008", "53741008", "22298006", "230690007"],
  },
  // Malignant neoplasms — the whole ICD-10 C chapter (C00–C96 are all malignant;
  // in-situ/benign D codes are deliberately excluded); SNOMED malignant
  // neoplastic disease. Drives the family-cancer history factor.
  {
    concept: "malignant-neoplasm",
    icd10Prefixes: ["C"],
    snomed: ["363346000"],
  },
  // Glaucoma — ICD-10 H40; SNOMED glaucoma. Drives the family-glaucoma factor
  // (AAO earlier/more-frequent eye exams). H40.0 ("glaucoma suspect") is
  // included on purpose: the existing "glaucoma" stem already matches that
  // label's text, and the only effect is a tighter (more cautious) eye-exam
  // cadence.
  { concept: "glaucoma", icd10Prefixes: ["H40"], snomed: ["23986001"] },
  // AHA antibiotic-prophylaxis high-risk cardiac categories (AHA/ACC 2007,
  // reaffirmed — the dental gate's own citation). Prosthetic valve material:
  // ICD-10 Z95.2 (prosthetic heart valve) / Z95.3 (xenogenic) / Z95.4 (other
  // valve replacement). No SNOMED entry — no single unambiguous concept id is
  // curated, so SNOMED-coded rows fall through to the keyword match.
  {
    concept: "prosthetic-heart-valve",
    icd10Prefixes: ["Z95.2", "Z95.3", "Z95.4"],
    snomed: [],
  },
  // Infective endocarditis — ICD-10 I33 (acute/subacute); SNOMED endocarditis.
  // (The generic Z86.79 "history of circulatory disease" is deliberately
  // EXCLUDED — far too broad; the SNOMED endocarditis concept is no broader
  // than the gate's existing "endocarditis" keyword.)
  {
    concept: "infective-endocarditis",
    icd10Prefixes: ["I33"],
    snomed: ["56819008"],
  },
  // High-risk (cyanotic) congenital heart disease — only the specific lesions
  // the AHA categories and the gate's own keywords name: transposition of the
  // great arteries (Q20.3), single ventricle / double-inlet ventricle (Q20.4),
  // tetralogy of Fallot (Q21.3). A broad Q2x prefix would sweep in low-risk
  // repaired defects (e.g. small ASDs) — exclusion discipline keeps them out.
  {
    concept: "high-risk-congenital-heart-disease",
    icd10Prefixes: ["Q20.3", "Q20.4", "Q21.3"],
    snomed: [],
  },
  // Cardiac transplant status — ICD-10 Z94.1 (heart transplant present).
  { concept: "cardiac-transplant", icd10Prefixes: ["Z94.1"], snomed: [] },
  // Condition→nutrient drop-rule targets (NIH ODS-derived dataset,
  // lib/datasets/nutrient-food-map): hyperkalemia (E87.5), hypercalcemia
  // (E83.52), Wilson disease (E83.01). CKD (magnesium/potassium anchor) is the
  // family above.
  { concept: "hyperkalemia", icd10Prefixes: ["E87.5"], snomed: ["14140009"] },
  { concept: "hypercalcemia", icd10Prefixes: ["E83.52"], snomed: ["66931009"] },
  {
    concept: "wilson-disease",
    icd10Prefixes: ["E83.01"],
    snomed: ["88518009"],
  },
];

// Which vocabulary a stored code_system labels. The importers store labeled
// systems ("ICD-10-CM", "SNOMED CT" — codeSystemLabel/systemLabel), but AI
// extraction and manual entry may leave the system blank, so a NULL/unknown
// system falls back to the code's SHAPE: ICD-10 codes are letter-led
// (letter + digits), SNOMED ids are all-digit — the two can't collide. A system
// that names a DIFFERENT vocabulary (ICD-9-CM, CPT, LOINC …) never code-matches.
type Vocabulary = "icd10" | "snomed" | "other" | "unknown";

function vocabularyOf(codeSystem: string | null | undefined): Vocabulary {
  const s = (codeSystem ?? "").trim();
  if (!s) return "unknown";
  if (/icd[\s-]*10/i.test(s) || s === "2.16.840.1.113883.6.90") return "icd10";
  if (/snomed/i.test(s) || s === "2.16.840.1.113883.6.96") return "snomed";
  return "other";
}

// Dot-insensitive, case-insensitive code normalization: "e11.9" → "E119".
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\./g, "");
}

const ICD10_SHAPE = /^[A-Z]\d/;
const SNOMED_SHAPE = /^\d+$/;

// The concepts a condition's stored CODE unambiguously identifies — empty when
// the row is uncoded, the system is a non-ICD-10/SNOMED vocabulary, or the code
// is outside every curated family (the consumer then falls through to its
// name/stem match, today's behavior).
export function conditionCodeConcepts(
  input: ConditionInput
): Set<ConditionConcept> {
  const out = new Set<ConditionConcept>();
  if (typeof input === "string") return out;
  const rawCode = input.code?.trim();
  if (!rawCode) return out;

  const vocab = vocabularyOf(input.codeSystem);
  if (vocab === "other") return out;
  const code = normalizeCode(rawCode);
  const asIcd10 =
    (vocab === "icd10" || (vocab === "unknown" && ICD10_SHAPE.test(code))) &&
    ICD10_SHAPE.test(code);
  const asSnomed =
    (vocab === "snomed" || (vocab === "unknown" && SNOMED_SHAPE.test(code))) &&
    SNOMED_SHAPE.test(code);

  for (const family of CONDITION_CODE_FAMILIES) {
    if (
      asIcd10 &&
      family.icd10Prefixes.some((p) => code.startsWith(normalizeCode(p)))
    ) {
      out.add(family.concept);
      continue;
    }
    if (asSnomed && family.snomed.includes(code)) out.add(family.concept);
  }
  return out;
}

// Whether a condition's code identifies the given concept — the per-concept
// code-first test consumers pair with their own name fallback.
export function conditionCodeMatches(
  input: ConditionInput,
  concept: ConditionConcept
): boolean {
  return conditionCodeConcepts(input).has(concept);
}
