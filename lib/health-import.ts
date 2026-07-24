import type {
  AllergyStatus,
  AppointmentKind,
  AppointmentStatus,
  ConditionStatus,
  ImagingLaterality,
  ImagingModality,
  MedicalCategory,
  MedicalFlag,
  MedStopReason,
  OpticalKind,
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
  // Specialty captured from the source (issue #1056): the NUCC taxonomy code
  // (CCDA assignedEntity <code>, FHIR PractitionerRole.specialty / qualification)
  // and its resolved display label. Both optional/null when the source omits them.
  specialtyCode?: string | null;
  specialty?: string | null;
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
  // Tier-1 visit link (#1050): the Encounter this Immunization.encounter referenced.
  encounter_external_id?: string | null;
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
  // Free-text body of a narrative report record (category === 'report', #708): the
  // resolved microbiology culture / gram stain / cytopathology report text. Set ONLY
  // on report records — every analyte/vital reading leaves it unset, and the persist
  // layer maps it into medical_records.notes.
  notes?: string | null;
  // The reading's OWN reference range + abnormal flag as stated by the SOURCE lab
  // (CCD `<referenceRange>` + `<interpretationCode>`), captured on `lab` records so an
  // analyte with no canonical band still shows the lab's normal range and its H/L/A
  // interpretation. `flag` seeds medical_records.flag (reconcileFlags then refines a
  // MAPPED lab against the canonical band and leaves an UNMAPPED lab's source flag
  // intact); `reference_range` is stored for display + the unit-mislabel cross-check.
  reference_range?: string | null;
  flag?: MedicalFlag | null;
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
  // Tier-1 visit link (#1050): the external_id of the Encounter this reading's FHIR
  // resource referenced (Observation/MedicationRequest.encounter), resolved within
  // the bundle. The persist layer maps it to the local encounter row's id. Null when
  // the source carried no encounter reference (or it dangled).
  encounter_external_id?: string | null;
  // Tier-1 indication link (#1052): the external_id of the Condition a
  // MedicationRequest.reasonReference pointed at, resolved within the bundle. Set only
  // on prescription records; the persist layer maps it to the local condition row and
  // stamps the projected medication's indication_condition_id. Null when the source
  // carried no reason reference (or it dangled).
  indication_condition_external_id?: string | null;
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
  // Tier-1 visit-diagnosis link (#1050): set when an Encounter.diagnosis[].condition
  // resolves to THIS condition — the visit it was diagnosed at. The prose blob on the
  // encounter stays for display; this is the row link. Null otherwise.
  encounter_external_id?: string | null;
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
  // The encounter TYPE code + labeled system (CPT/CDT/SNOMED, #1035) — the coding
  // the display `type` was resolved from. Feeds the preventive concept map's
  // visit-rule code sets (a 99396 "Office Visit" IS the annual physical). Distinct
  // from `class_code` (the AMB/IMP/EMER class).
  code: string | null;
  code_system: string | null;
  class_code: string | null; // HL7 ActEncounterCode class, e.g. "AMB"
  reason: string | null; // chief complaint / reason for visit text
  diagnoses: string[]; // visit diagnosis display names (may be empty)
  provider: ImportedProvider | null; // attending / performing clinician
  location: ImportedProvider | null; // facility / performing organization
  notes: string | null; // the encounter's free-text narrative / visit summary
  external_id: string; // stable dedup key ("ccda:encounter:<id>")
  // TRANSIENT (#1050) — the external_ids of the Conditions this visit diagnosed
  // (FHIR Encounter.diagnosis[].condition, resolved in-bundle). Consumed by the
  // bundle assembler's tagging post-pass to stamp each condition's
  // encounter_external_id, then dropped — it is NEVER persisted on the encounter row.
  diagnosis_condition_external_ids?: string[];
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
  // Tier-1 visit link (#1050): the Encounter this Procedure.encounter referenced.
  encounter_external_id?: string | null;
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

// A structured imaging study pulled from a FHIR ImagingStudy resource, an imaging
// DiagnosticReport (its conclusion/presentedForm narrative), or an imaging
// DocumentReference (an inline-text rendered report) — the deterministic structured
// feed for the imaging_studies record type (#702), added by #708. Provider-neutral
// and DB-shaped: modality/laterality are already normalized onto the imaging CHECK
// sets (lib/imaging-study.ts) and `contrast` is a bool, so the persist layer maps it
// straight to a PersistImagingStudy. FHIR-only today — no CDA imaging section exists.
export interface ImportedImagingStudy {
  modality: ImagingModality; // normalized ('other' when unclassifiable)
  body_region: string | null;
  laterality: ImagingLaterality | null;
  contrast: boolean;
  contrast_agent: string | null;
  study_date: string | null; // YYYY-MM-DD
  dose_msv: number | null; // effective dose (mSv); null on the FHIR path (#703)
  impression: string | null; // the radiologist's impression / rendered report narrative
  indication: string | null; // reason the study was ordered
  status: string | null; // free-text passthrough (no enum)
  external_id: string; // stable dedup key ("fhir:imaging:…")
}

// A structured optical (eyeglass / contact-lens) prescription pulled from a FHIR
// VisionPrescription resource (#708 → #697). Provider-neutral + DB-shaped: `kind` is
// already on the OpticalKind enum and every per-eye power / axis / distance is parsed
// to a number via the shared optical-prescription coercion (#221), so the persist
// layer maps it straight to a PersistOpticalPrescription. FHIR-only today — no CDA
// vision section exists (optical Rx otherwise arrives via the AI Rx-slip path).
export interface ImportedOpticalPrescription {
  kind: OpticalKind;
  od_sphere: number | null;
  od_cylinder: number | null;
  od_axis: number | null;
  od_add: number | null;
  os_sphere: number | null;
  os_cylinder: number | null;
  os_axis: number | null;
  os_add: number | null;
  pd: number | null; // interpupillary distance (mm), when the resource carries one
  base_curve: number | null; // contact-lens base curve (mm)
  diameter: number | null; // contact-lens diameter (mm)
  brand: string | null;
  issued_date: string | null; // dateWritten → YYYY-MM-DD
  expiry_date: string | null; // no standard R4 element — null unless an extension carries it
  provider: ImportedProvider | null; // the prescribing optometrist / ophthalmologist
  notes: string | null; // prism + free-text notes (the row has no prism column)
  external_id: string; // stable dedup key ("fhir:vision:<id>")
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
  // The patient's OWN postal code from the CDA header (recordTarget/patientRole/
  // addr/postalCode), if present (issue #570). Used ONLY to suggest a coarse
  // ZIP-centroid home location offline — never a street address. Optional so other
  // importers (FHIR) that don't populate it need no change.
  postalCode?: string | null;
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
  // Structured imaging studies (#708 → #702). Optional (default []): the FHIR
  // ImagingStudy / imaging DiagnosticReport / imaging DocumentReference mappers
  // populate it; the CDA path and other parsers omit it (FHIR is dental/imaging-poor
  // structurally elsewhere — imaging arrives structured in Epic/Apple bundles).
  imagingStudies?: ImportedImagingStudy[];
  // Structured optical prescriptions (#708 → #697). Optional (default []): the FHIR
  // VisionPrescription mapper populates it; the CDA path and other parsers omit it
  // (optical Rx is FHIR-only structurally — otherwise it arrives via AI Rx-slip).
  opticalPrescriptions?: ImportedOpticalPrescription[];
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
