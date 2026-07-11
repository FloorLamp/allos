import type { ImportResult } from "../health-import";

export class CdaError extends Error {}

// ---- section catalog (LOINC section codes + C-CDA templateIds) ----

export const SECTIONS = {
  immunizations: {
    loinc: "11369-6",
    templates: [
      "2.16.840.1.113883.10.20.22.2.2",
      "2.16.840.1.113883.10.20.22.2.2.1",
    ],
  },
  results: {
    loinc: "30954-2",
    templates: [
      "2.16.840.1.113883.10.20.22.2.3",
      "2.16.840.1.113883.10.20.22.2.3.1",
    ],
  },
  vitals: {
    loinc: "8716-3",
    templates: [
      "2.16.840.1.113883.10.20.22.2.4",
      "2.16.840.1.113883.10.20.22.2.4.1",
    ],
  },
  medications: {
    loinc: "10160-0",
    templates: [
      "2.16.840.1.113883.10.20.22.2.1",
      "2.16.840.1.113883.10.20.22.2.1.1",
    ],
  },
  // Care Teams: a provider source, not a clinical reading. The
  // section lists the patient's named clinicians/organizations, which we register
  // into the shared providers registry.
  careTeams: {
    loinc: "85847-2",
    templates: ["2.16.840.1.113883.10.20.22.2.500"],
  },
  allergies: {
    loinc: "48765-2",
    templates: [
      "2.16.840.1.113883.10.20.22.2.6",
      "2.16.840.1.113883.10.20.22.2.6.1",
    ],
  },
  problems: {
    loinc: "11450-4",
    templates: [
      "2.16.840.1.113883.10.20.22.2.5",
      "2.16.840.1.113883.10.20.22.2.5.1",
    ],
  },
  // History of Past Illness (#265) — Epic titles it "Resolved Problems". The
  // entries are the SAME Problem Concern Act shape the Problems section carries,
  // just for past/resolved problems (resolved status observations, effectiveTime
  // highs). Routed through the same condition mapper with a section-level default
  // of `resolved`: the section's semantics ("past illness") beat the concern act's
  // tracking statusCode, but an explicit clinical-status observation (4.6) is
  // still authoritative.
  pastIllness: {
    loinc: "11348-0",
    templates: ["2.16.840.1.113883.10.20.22.2.20"],
  },
  // Hospital Admitting Diagnoses (#266). Entries are a Hospital Admission
  // Diagnosis act wrapping Problem Observations (4.4) — the same deep-walk shape
  // as Visit Diagnoses. Not an extractor of its own: read at the document level
  // and routed into the SAME visit-diagnosis handling (correlated onto the
  // same-document encounter when there is a single one, else landed as
  // problem-list conditions with visit-diagnosis provenance).
  admissionDiagnoses: {
    loinc: "46241-6",
    templates: ["2.16.840.1.113883.10.20.22.2.43"],
  },
  // Medications at Time of Discharge (#266) — the take-home regimen snapshot on an
  // inpatient discharge document. Entries are Medication Activity (4.16), the same
  // shape the Medications extractor parses; the entry's own coded status is
  // trusted (it IS the intended ongoing med list), and each derived course is
  // tagged "At hospital discharge" for provenance.
  dischargeMedications: {
    loinc: "10183-2",
    templates: ["2.16.840.1.113883.10.20.22.2.11"],
  },
  // Administered Medications (#266) — meds GIVEN during the encounter/stay, not an
  // ongoing regimen. Same Medication Activity (4.16) entries, but mapped in
  // snapshot mode: an active/unstated status is capped to `completed` so a
  // one-off inpatient administration can never surface as a current (open-course)
  // medication.
  administeredMedications: {
    loinc: "29549-3",
    templates: ["2.16.840.1.113883.10.20.22.2.38"],
  },
  // Ordered Prescriptions (#268) — an Epic section (no C-CDA section templateId of
  // its own; Epic stamps its proprietary 1.2.840.114350.1.72.2.10144) listing the
  // prescriptions WRITTEN at the visit. Entries are Medication Activity (4.16), the
  // same shape the Medications extractor parses — but the section documents an
  // ORDER event, not the patient's current regimen (the Medications section stays
  // the authority for that), so mapMedication runs in snapshot mode: an
  // active/unstated status is capped to `completed` and an undated order anchors to
  // the document date, so a years-old visit's order can never surface as a current
  // (open-course) medication. Each derived course is tagged "Ordered at visit".
  orderedPrescriptions: {
    loinc: "66149-6",
    templates: ["1.2.840.114350.1.72.2.10144"],
  },
  // Functional Status (#268). Entries are functional-status / assessment
  // observations (organizer→component or bare observation — the SAME node shapes
  // the Results/Vitals walker reads), typically with coded (qualitative) values
  // ("Independent", "Uses walker", …). Routed through the shared observation
  // mapper as qualitative `lab` records; the assessment LOINC is deliberately NOT
  // carried onto the stored record — see functionalStatusExtractor.
  functionalStatus: {
    loinc: "47420-5",
    templates: ["2.16.840.1.113883.10.20.22.2.14"],
  },
  // Insurance / Payers (#268) — Coverage Activity entries (plan names, subscriber
  // ids, payer contacts). Deliberately OUT OF SCOPE: it's billing/coverage data,
  // not health readings, and importing subscriber/group identifiers adds risk with
  // no clinical surface to show them on. Recognized so the coverage report lists
  // it as "recognized, not imported" instead of an unrecognized-section gap — see
  // buildCcdaCoverage. No extractor.
  insurance: {
    loinc: "48768-6",
    templates: ["2.16.840.1.113883.10.20.22.2.18"],
  },
  // Encounters / visit history. The "History of
  // Hospitalizations + Outpatient visits" section; each entry is an Encounter
  // Activity (templateId 4.49) carrying the visit's date/period, type/class,
  // performing clinician, location, and (nested) visit diagnoses.
  encounters: {
    loinc: "46240-8",
    templates: [
      "2.16.840.1.113883.10.20.22.2.22",
      "2.16.840.1.113883.10.20.22.2.22.1",
    ],
  },
  // Reason for Visit (chief complaint 8661-1). Not a stored record on its own —
  // read at the document level and correlated onto the encounter.
  reasonForVisit: {
    loinc: "29299-5",
    templates: ["2.16.840.1.113883.10.20.22.2.12"],
  },
  // Social History. Carries the patient's coded sex (Sex assigned at
  // birth / Sex) — used to enrich the header demographics — and the tobacco smoking
  // status, captured as a social-history condition. Observations are keyed by their
  // LOINC <code> (72166-2 / 76689-9 / 46098-0), NOT by templateId: the Sex 46098-0
  // observation also carries the 4.38 templateId (historically "Tobacco Use"), so
  // keying smoking off 4.38 would misclassify it — the LOINC is authoritative.
  socialHistory: {
    loinc: "29762-2",
    templates: ["2.16.840.1.113883.10.20.22.2.17"],
  },
  // Procedures / surgical history (LOINC 47519-4). Each entry is a Procedure
  // Activity (procedure 4.14, act 4.12, or observation 4.13) carrying the coded
  // procedure, its effectiveTime, and a performer.
  procedures: {
    loinc: "47519-4",
    templates: [
      "2.16.840.1.113883.10.20.22.2.7",
      "2.16.840.1.113883.10.20.22.2.7.1",
    ],
  },
  // Family History (LOINC 10157-6). Each entry is a Family History Organizer (4.45)
  // for one relative, whose subject codes the relationship and whose nested Family
  // History Observations (4.46) carry that relative's conditions.
  familyHistory: {
    loinc: "10157-6",
    templates: ["2.16.840.1.113883.10.20.22.2.15"],
  },
  // Plan of Treatment / Care Plan (LOINC 18776-5). Each entry is a planned act /
  // encounter / observation / substanceAdministration / procedure (an INT/RQO/PRMS/…
  // mood) carrying the coded planned activity, its intended effectiveTime, and an
  // ordering performer. The older HITSP "Plan of Care" template is 2.10; the C-CDA
  // Plan of Treatment section is 2.10.1.
  carePlan: {
    loinc: "18776-5",
    templates: [
      "2.16.840.1.113883.10.20.22.2.10",
      "2.16.840.1.113883.10.20.22.2.10.1",
    ],
  },
  // Goals (LOINC 61146-7). Each entry is a Goal Observation (4.121) carrying the
  // goal statement (code / value), its target effectiveTime, and a status.
  goals: {
    loinc: "61146-7",
    templates: ["2.16.840.1.113883.10.20.22.2.60"],
  },
  // Standalone Visit Diagnoses (LOINC 29308-4 "Diagnosis"). Epic Encounter Summary
  // CCDs often emit the visit diagnoses as a TOP-LEVEL section rather than nested in
  // an Encounter Activity (which the encounter deep-walk already consumes — #71).
  // Not an extractor of its own: read at the document level and routed into the SAME
  // encounter-diagnosis store — correlated onto the same-document encounter when there
  // is a single one (mirroring Reason for Visit), else landed as problem-list
  // conditions. There is no stable C-CDA section templateId, so it matches by LOINC.
  visitDiagnoses: {
    loinc: "29308-4",
    templates: [],
  },
  // Progress Notes (LOINC 11506-3). A per-visit clinician progress note emitted as a
  // TOP-LEVEL narrative section (the note text lives in the section <text>), not the
  // encounter-nested Comment Activity the encounter walk already reads. Handled with
  // the per-clinician "Notes from <clinician>" sections (see CLINICAL_NOTE_LOINCS /
  // isClinicalNoteSection) at the document level: attached to the same-document
  // encounter's notes when there is a single one, else stored as a standalone dated
  // note (a note-only encounter row). No section templateId — matched by LOINC/title.
  progressNotes: {
    loinc: "11506-3",
    templates: [],
  },
} as const;

// Per-clinician clinical-note section LOINCs. Epic emits one "Notes from <clinician>"
// section per note type/author, and the section <code> LOINC varies by deployment and
// note type — so recognition is this small set of common clinical-note codes PLUS a
// title heuristic ("note(s)" in the section title, see isClinicalNoteSection) for a
// deployment-specific code we haven't catalogued. Progress Notes (11506-3) is included
// so a "Notes from …" wrapper carrying it routes through the same note path.
export const CLINICAL_NOTE_LOINCS = new Set<string>([
  "11506-3", // Progress note
  "11488-4", // Consultation note
  "34117-2", // History and physical note
  "18842-5", // Discharge summary
  "8648-8", // Hospital course / Discharge Summaries (IHE 1.3.6.1.4.1.19376.1.5.3.1.3.5, Note Activity entries) — #266
  "8653-8", // Discharge Instructions (2.16.840.1.113883.10.20.22.2.41, Instruction entries) — #266
  "69730-0", // Patient Instructions (2.16.840.1.113883.10.20.22.2.45, Instruction entries) — #268
  "28570-0", // Procedure note
  "34109-9", // Note
  "34111-5", // Emergency department note
  "68552-9", // Emergency medicine Progress note
]);

export const LOINC_OID = "2.16.840.1.113883.6.1";

// Code-system OIDs used to label a condition/substance code.
export const SNOMED_OID = "2.16.840.1.113883.6.96";

export const ICD10CM_OID = "2.16.840.1.113883.6.90";

export const ICD9CM_OID = "2.16.840.1.113883.6.103";

export const ICD10PCS_OID = "2.16.840.1.113883.6.4";

export const RXNORM_OID = "2.16.840.1.113883.6.88";

// CPT-4 (procedure codes) and HCPCS — common on Procedures-section codes.
export const CPT_OID = "2.16.840.1.113883.6.12";

export const HCPCS_OID = "2.16.840.1.113883.6.285";

// C-CDA templateIds for the entry-level acts/observations these extractors walk.
export const PROBLEM_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.4";

export const ALLERGY_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.7";

export const SEVERITY_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.8";

export const STATUS_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.6";

// HL7 ActEncounterCode (v3 ActCode) — the encounter class translation (AMB / IMP /
// EMER / …) that rides alongside a CPT/local type code on an Encounter.
export const ACT_CODE_OID = "2.16.840.1.113883.5.4";

// Procedure Activity entry templates (procedure / act / observation flavors) —
// the three shapes a Procedures-section entry can carry.
const PROCEDURE_ACT_TEMPLATES = [
  "2.16.840.1.113883.10.20.22.4.14", // Procedure Activity Procedure
  "2.16.840.1.113883.10.20.22.4.12", // Procedure Activity Act
  "2.16.840.1.113883.10.20.22.4.13", // Procedure Activity Observation
];

// Family History Observation (a relative's condition) + the Age Observation nested
// under it (the relative's age at onset). The organizer's subject/relatedSubject
// carries the relationship + deceased status.
export const FAMILY_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.46";

export const AGE_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.31";

// Goal Observation (a single goal statement in a Goals section).
const GOAL_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.121";

// The US National Provider Identifier assigning authority OID. An <id> with this
// root carries a provider's NPI (authoritative for the global provider dedup).
export const NPI_OID = "2.16.840.1.113883.4.6";

// Social History observation LOINCs. The section entries are identified by
// these codes on the observation's <code>, not by templateId (see SECTIONS note).
export const SMOKING_STATUS_LOINC = "72166-2"; // Tobacco smoking status (NHIS)

export const SEX_AT_BIRTH_LOINC = "76689-9"; // Sex assigned at birth

export const SEX_LOINC = "46098-0"; // Sex

// ---- document → sections ----

export interface CdaSection {
  code: string | null; // LOINC section code
  templateIds: string[];
  title: string | null;
  entries: any[]; // raw <entry> objects (parser output)
  raw: any; // the raw <section> object, for anything not surfaced above
}

export interface SectionExtractor {
  key: string; // e.g. 'immunizations', 'medications'
  matches: (section: CdaSection) => boolean;
  // `documentDate` is the ClinicalDocument's effectiveTime — the medications
  // extractor uses it as the fallback date for an undated med-list entry (#Fix 2).
  // Other extractors ignore it.
  extract: (
    section: CdaSection,
    documentDate?: string | null
  ) => Partial<ImportResult>;
}

// A resolved value string that is empty or a bare placeholder ("—", "-", "N/A",
// …) carries no result. Normalize it to null so the observation is dropped
// rather than surfacing as an empty record the app renders as "—".
export const VALUE_PLACEHOLDERS = new Set([
  "",
  "-",
  "–",
  "—",
  "n/a",
  "na",
  "not applicable",
]);

// The C-CDA Comment Activity template — the standard home for a free-text note
// attached to an entry (a visit summary / clinician comment on an encounter).
export const COMMENT_ACT_TEMPLATE = "2.16.840.1.113883.10.20.22.4.64";

// HL7 v3 FamilyMember role codes → a friendly relative label, used when the coded
// <relatedSubject><code> carries no displayName. Not exhaustive — the raw code is
// the fallback, so an unmapped relation still imports (just less pretty).
export const FAMILY_RELATION_LABELS: Record<string, string> = {
  MTH: "Mother",
  FTH: "Father",
  SIS: "Sister",
  BRO: "Brother",
  SIB: "Sibling",
  DAU: "Daughter",
  SON: "Son",
  CHILD: "Child",
  GRMTH: "Grandmother",
  GRFTH: "Grandfather",
  MGRMTH: "Maternal grandmother",
  MGRFTH: "Maternal grandfather",
  PGRMTH: "Paternal grandmother",
  PGRFTH: "Paternal grandfather",
  GRPRN: "Grandparent",
  AUNT: "Aunt",
  UNCLE: "Uncle",
  COUSN: "Cousin",
  NMTH: "Mother",
  NFTH: "Father",
};

// The planned-activity element carried under a Plan-of-Treatment entry and a
// friendly category label for it. A section entry wraps exactly one of these (the
// mood is planned/ordered — INT/RQO/PRMS/PRP/…); the element type IS the category.
export const CARE_PLAN_ELEMENTS: { key: string; category: string }[] = [
  { key: "act", category: "activity" },
  { key: "encounter", category: "encounter" },
  { key: "observation", category: "observation" },
  { key: "substanceAdministration", category: "medication" },
  { key: "supply", category: "supply" },
  { key: "procedure", category: "procedure" },
];

// A human title for a section: its own <title>, else a known catalog name, else the
// LOINC code. Epic sets titles ("Insurance", "Plan of Treatment"), which is exactly
// what the "present but not consumed" list wants to show.
export const KNOWN_SECTION_TITLES: Record<string, string> = {
  [SECTIONS.immunizations.loinc]: "Immunizations",
  [SECTIONS.results.loinc]: "Results",
  [SECTIONS.vitals.loinc]: "Vital Signs",
  [SECTIONS.medications.loinc]: "Medications",
  [SECTIONS.careTeams.loinc]: "Care Teams",
  [SECTIONS.allergies.loinc]: "Allergies",
  [SECTIONS.problems.loinc]: "Problems",
  [SECTIONS.pastIllness.loinc]: "Resolved Problems",
  [SECTIONS.admissionDiagnoses.loinc]: "Admitting Diagnoses",
  [SECTIONS.dischargeMedications.loinc]: "Discharge Medications",
  [SECTIONS.administeredMedications.loinc]: "Administered Medications",
  [SECTIONS.orderedPrescriptions.loinc]: "Ordered Prescriptions",
  [SECTIONS.functionalStatus.loinc]: "Functional Status",
  [SECTIONS.insurance.loinc]: "Insurance",
  [SECTIONS.encounters.loinc]: "Encounters",
  [SECTIONS.procedures.loinc]: "Procedures",
  [SECTIONS.familyHistory.loinc]: "Family History",
  [SECTIONS.carePlan.loinc]: "Plan of Treatment",
  [SECTIONS.goals.loinc]: "Goals",
  [SECTIONS.reasonForVisit.loinc]: "Reason for Visit",
  [SECTIONS.socialHistory.loinc]: "Social History",
  [SECTIONS.visitDiagnoses.loinc]: "Visit Diagnoses",
  [SECTIONS.progressNotes.loinc]: "Progress Notes",
  // Clinical-note section codes with no SECTIONS spec of their own (#266/#268).
  "8648-8": "Discharge Summaries",
  "8653-8": "Discharge Instructions",
  "69730-0": "Patient Instructions",
};
