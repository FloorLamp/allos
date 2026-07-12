import type {
  AllergyStatus,
  AppointmentKind,
  AppointmentStatus,
  ConditionStatus,
  MedicalCategory,
  MedStopReason,
  ProviderType,
  Sex,
} from "./types";
import type { ImportReport } from "./import-report";

// A derived medication COURSE (episode) carried on an imported medication record
//. started_on/stopped_on are the source's effective-period
// bounds (YYYY-MM-DD); stopped_on null means the course is still open (the med is
// ongoing). stop_reason is derived from the source status (completed →
// completed_course, stopped → provider_discontinued, …); notes carries a short
// status/reason detail. Provider-neutral: both the CCD and FHIR importers produce
// these (lib/medication-course-import), and one persist path turns them into
// medication_courses rows.
export interface ImportedMedicationCourse {
  started_on: string | null;
  stopped_on: string | null;
  stop_reason: MedStopReason | null;
  notes: string | null;
}

// A provider/organization captured from a health record (a CCD `<performer>` or
// the Care Teams section), before it's resolved into the shared global providers
// registry. Provider-neutral so every parser can produce it. The
// pure normalize/dedup key lives in lib/providers; the DB resolver in
// lib/providers-db turns one of these into a shared providers row id.
export interface ImportedProvider {
  name: string;
  type: ProviderType;
  npi: string | null;
  identifier: string | null;
  phone: string | null;
  address: string | null;
}

// Shared shapes for records pulled out of a portal export (MyChart CCD/XDM or a
// SMART Health Card). Keeping them provider-neutral lets one persistence path in
// the import action handle everything, and lets the parsers grow to cover more
// of the record (labs today; vitals, medications, problems, allergies as
// extractors are added) without changing the writer.

export interface ImportedImmunization {
  code: string; // catalog/combo/slug code (lib/immunization-catalog)
  date: string; // YYYY-MM-DD
  dose_label: string | null;
  notes: string | null;
  external_id: string; // stable dedup key
  // The administering provider/organization (CCD `<performer>`), when carried.
  // Resolved into the shared registry and linked via immunizations.provider_id.
  provider?: ImportedProvider | null;
}

// A generic clinical record destined for `medical_records`. `category` decides
// the column value (lab result, vital sign, prescription, …) so a single insert
// path can persist every section an extractor understands.
export interface ImportedRecord {
  category: MedicalCategory;
  name: string;
  canonical: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  date: string; // YYYY-MM-DD
  external_id: string;
  // The reading's LOINC code when the source carries one (CCD/FHIR vitals/labs),
  // used to route body-height readings into metric_samples (lib/height-extract).
  // Optional — extractors that don't resolve a LOINC leave it unset.
  loinc?: string | null;
  // The performing provider/organization (CCD observation `<performer>`, e.g.
  // "QUEST"), when carried. Resolved into the shared registry and linked via
  // medical_records.provider_id.
  provider?: ImportedProvider | null;
  // Medication COURSES derived from the source's effective
  // period(s) + lifecycle status — set ONLY on `category === 'prescription'`
  // records by the CCD/FHIR importers. When present + non-empty, the persist layer
  // creates one medication_courses row per course (open/closed synced to
  // intake_items.active) INSTEAD of the Phase-1 single open course; when absent/
  // empty it falls back to that single ensure-course. Other record categories
  // leave it unset.
  courses?: ImportedMedicationCourse[] | null;
  // Structured medication attribution, set ONLY on prescription records by the
  // CCD/FHIR importers (FHIR requester / dispenseRequest.performer / identifier;
  // CCD med <author> + <supply>). Threaded into the auto-structured intake_items
  // row's prescriber / pharmacy / rx_number columns so an imported med carries the
  // source's own attribution instead of always NULL (#417).
  prescriber?: string | null;
  pharmacy?: string | null;
  rxNumber?: string | null;
}

// An allergy / intolerance pulled from a CCD Allergies section. Substance
// is the offending agent; reaction/severity/status are as coded/printed. A
// "No known allergies" statement is dropped upstream — it never becomes a row.
export interface ImportedAllergy {
  substance: string;
  substance_code: string | null;
  substance_code_system: string | null;
  reaction: string | null;
  severity: string | null;
  status: AllergyStatus;
  onset_date: string | null; // YYYY-MM-DD
  external_id: string; // stable dedup key
}

// A problem-list condition pulled from a CCD Active Problems section.
export interface ImportedCondition {
  name: string;
  code: string | null;
  code_system: string | null;
  status: ConditionStatus;
  onset_date: string | null; // YYYY-MM-DD
  resolved_date: string | null;
  external_id: string;
}

// A visit / encounter pulled from a CCD Encounters section.
// Provider-neutral: the attending clinician and the facility/location are captured
// as ImportedProviders and resolved into the shared registry on persist (linked
// via encounters.provider_id / location_provider_id). Diagnoses are captured as a
// flat list of display names (stored as a joined summary — see the encounters
// table). Fields default to null when the source omits them (nullFlavor / missing).
export interface ImportedEncounter {
  date: string; // start / effectiveTime low, YYYY-MM-DD
  end_date: string | null; // effectiveTime high, YYYY-MM-DD
  type: string | null; // encounter type display, e.g. "Office Visit"
  class_code: string | null; // HL7 ActEncounterCode class, e.g. "AMB"
  reason: string | null; // chief complaint / reason for visit text
  diagnoses: string[]; // visit diagnosis display names (may be empty)
  provider: ImportedProvider | null; // attending / performing clinician
  location: ImportedProvider | null; // facility / performing organization
  notes: string | null; // the encounter's free-text narrative / visit summary
  external_id: string; // stable dedup key ("ccda:encounter:<id>")
}

// A procedure pulled from a CCD Procedures section or a FHIR Procedure resource.
// Provider-neutral: the performing clinician is captured as an ImportedProvider and
// resolved into the shared registry on persist (linked via procedures.provider_id).
export interface ImportedProcedure {
  name: string;
  code: string | null;
  code_system: string | null;
  date: string | null; // YYYY-MM-DD, when known
  provider: ImportedProvider | null;
  external_id: string; // stable dedup key ("ccda:procedure:…")
}

// A family-history entry — one condition affecting one relative — pulled from a CCD
// Family History section or a FHIR FamilyMemberHistory resource. relation is the
// affected relative; condition its display term; onset_age the relative's age at
// onset (years) when known; deceased 1/0/null.
export interface ImportedFamilyHistory {
  relation: string | null;
  condition: string;
  code: string | null;
  code_system: string | null;
  onset_age: number | null;
  deceased: number | null;
  external_id: string; // stable dedup key ("ccda:famhx:…")
}

// A care-plan item — one planned/ordered future care activity — pulled from a CCD
// Plan of Treatment / Care Plan section or a FHIR CarePlan activity. Provider-
// neutral: the ordering clinician is captured as an ImportedProvider and resolved
// into the shared registry on persist (linked via care_plan_items.provider_id).
export interface ImportedCarePlanItem {
  description: string;
  code: string | null;
  code_system: string | null;
  category: string | null; // procedure / encounter / medication / observation / …
  planned_date: string | null; // YYYY-MM-DD, when known
  status: string | null;
  provider: ImportedProvider | null;
  external_id: string; // stable dedup key ("ccda:careplan:…")
}

// A care goal — a clinical target — pulled from a CCD Goals section or a FHIR Goal
// resource. description is the goal statement; target_date when it's aimed to be
// met; status the lifecycle (proposed / active / achieved / …).
export interface ImportedCareGoal {
  description: string;
  code: string | null;
  code_system: string | null;
  target_date: string | null; // YYYY-MM-DD, when known
  status: string | null;
  external_id: string; // stable dedup key ("ccda:caregoal:…")
}

// A scheduled visit / appointment pulled from a FHIR Appointment resource (issue
// #416). No CDA appointment section exists, so this is FHIR-only today.
// Provider-neutral: the attending clinician is captured as an ImportedProvider and
// resolved into the shared registry on persist (linked via appointments.provider_id);
// the facility is a plain `location` string (the appointments table stores location
// as text, not a provider FK). `kind` is best-effort from the FHIR service/type
// codings (null when not clearly one of the app's kinds — a null kind never matches a
// preventive rule). scheduled_at preserves the source's date (and time when present).
export interface ImportedAppointment {
  scheduled_at: string; // YYYY-MM-DD or "YYYY-MM-DDTHH:MM"
  status: AppointmentStatus;
  title: string | null;
  location: string | null;
  notes: string | null;
  kind: AppointmentKind | null;
  provider: ImportedProvider | null;
  external_id: string; // stable dedup key ("fhir:appointment:<id>")
}

// Patient demographics read from the export's header/Patient resource (not a
// clinical record — these fill the profile's sex/birthdate when they're unset).
export interface ImportDemographics {
  sex: Sex | null;
  birthdate: string | null; // YYYY-MM-DD
  name: string | null; // patient name as printed on the record (document provenance)
}

export interface ImportResult {
  immunizations: ImportedImmunization[];
  records: ImportedRecord[];
  // Allergies + problem-list conditions. Optional so the FHIR / SMART
  // Health Card parsers (which don't yet emit these) need no change — consumers
  // default to []. The CCD extractor populates them.
  allergies?: ImportedAllergy[];
  conditions?: ImportedCondition[];
  // Visits / encounters. Optional for the same reason — only the CCD
  // Encounters section populates it; other parsers default to [].
  encounters?: ImportedEncounter[];
  // Procedures + family history. Optional (default []): the CCD Procedures / Family
  // History sections and the FHIR Procedure / FamilyMemberHistory resources populate
  // them; other parsers omit them.
  procedures?: ImportedProcedure[];
  familyHistory?: ImportedFamilyHistory[];
  // Care plan items + care goals. Optional (default []): the CCD Plan of Treatment /
  // Care Plan + Goals sections and the FHIR CarePlan / Goal resources populate them;
  // other parsers omit them.
  carePlanItems?: ImportedCarePlanItem[];
  careGoals?: ImportedCareGoal[];
  // Scheduled visits / appointments. Optional (default []): only the FHIR Appointment
  // resource populates it (issue #416); the CDA path and other parsers omit it.
  appointments?: ImportedAppointment[];
  demographics: ImportDemographics | null;
  // Providers/organizations captured from the record that aren't tied to a single
  // reading — the CCD Care Teams section. Registered into the shared
  // registry so the family's provider list is populated even before a record is
  // manually linked. Optional: parsers that don't surface care teams omit it.
  providers?: ImportedProvider[];
  // The import DEBUGGER report: every candidate the parser
  // DROPPED and why, plus which sections/resource-types it did/didn't consume.
  // Additive + optional so existing callers (and the AI extraction path, which
  // produces no structured report) are unaffected. The deterministic CCD/FHIR
  // parsers populate it; import-persist stores it on the document.
  report?: ImportReport;
}
