// Extracted record shapes — the source of truth for what one medical-document
// extraction yields, and the ExtractionResult union the pipeline returns.
import type { MedicalCategory, MedicalFlag, Sex } from "../types";
import type { ImportDrop } from "../import-report";
import type { ReconcileReport } from "./reconcile";

// Structured prescription fields the model reads straight off a pharmacy label /
// medication order (#414). Emitted ONLY on `category === 'prescription'` results,
// so the sig / prescriber / pharmacy / Rx number no longer have to be regex-
// reconstructed from a free-text note downstream. Preferred by the persist layer
// when present; `parsePrescription` stays the fallback for legacy stored
// extractions that carry only a note. The conservative "no invented schedule"
// rule still applies as post-validation — an unparseable sig yields an as-needed
// med (parsePrescription/parseSig), never a fabricated daily reminder.
export interface ExtractedPrescription {
  sig: string | null; // directions verbatim, e.g. "Take 1 tablet by mouth daily"
  strength: string | null; // per-dose strength, e.g. "10 mg"
  prn: number | null; // 1 when the label states as-needed / PRN, else 0/null
  prescriber: string | null; // ordering clinician name, e.g. "Grace Hopper, MD"
  pharmacy: string | null; // dispensing pharmacy name
  rx_number: string | null; // prescription / Rx number as printed
  start_date: string | null; // YYYY-MM-DD the course started, when printed
}

export interface ExtractedResult {
  category: MedicalCategory;
  panel: string | null;
  name: string;
  canonical_name: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  reference_range: string | null;
  flag: MedicalFlag | null;
  collected_date: string | null;
  notes: string | null;
  // Structured prescription attribution/schedule for a `prescription` result
  // (#414). Null for every non-medication result and for a medication the model
  // couldn't structure — the persist layer then falls back to parsePrescription.
  // Optional so existing ExtractedResult constructors (test fixtures) need no
  // change; normalizeResults always sets it (null when absent).
  prescription?: ExtractedPrescription | null;
}

// One vaccine administration extracted from an immunization record / vaccine
// card. `vaccine` is the name/brand exactly as printed; it's normalized to a
// catalog code by lib/immunization-extract (never dropped — slug fallback).
export interface ExtractedImmunization {
  vaccine: string;
  date: string | null; // YYYY-MM-DD
  dose_label: string | null;
  notes: string | null;
}

// The clinical-narrative domains the AI extractor now emits (parity with the
// deterministic CCD/FHIR importer). These are the PRE-persist AI shapes: statuses
// stay as the model's raw string (normalized to the CHECK sets in import-shape),
// dates are already coerced to strict ISO-or-null, and providers/facilities are
// captured as plain names (resolved into the shared providers registry on persist).
export interface ExtractedCondition {
  name: string;
  code: string | null;
  code_system: string | null;
  status: string | null; // raw clinical status; normalized in import-shape
  onset_date: string | null; // YYYY-MM-DD
  resolved_date: string | null; // YYYY-MM-DD
}

export interface ExtractedAllergy {
  substance: string;
  substance_code: string | null;
  substance_code_system: string | null;
  reaction: string | null;
  severity: string | null;
  status: string | null; // raw clinical status; normalized in import-shape
  onset_date: string | null; // YYYY-MM-DD
}

export interface ExtractedProcedure {
  name: string;
  code: string | null;
  code_system: string | null;
  date: string | null; // YYYY-MM-DD
}

export interface ExtractedEncounter {
  date: string; // YYYY-MM-DD (required — a dateless encounter is dropped)
  end_date: string | null; // YYYY-MM-DD
  type: string | null;
  class_code: string | null;
  reason: string | null;
  diagnoses: string[];
  provider: string | null; // attending clinician name (resolved on persist)
  location: string | null; // facility name (resolved on persist)
  notes: string | null;
}

export interface ExtractedFamilyHistory {
  relation: string | null;
  condition: string;
  code: string | null;
  code_system: string | null;
  onset_age: number | null;
  deceased: number | null; // 1/0/null
}

export interface ExtractedCarePlanItem {
  description: string;
  code: string | null;
  code_system: string | null;
  category: string | null;
  planned_date: string | null; // YYYY-MM-DD
  status: string | null; // free-text passthrough (no enum)
}

export interface ExtractedCareGoal {
  description: string;
  code: string | null;
  code_system: string | null;
  target_date: string | null; // YYYY-MM-DD
  status: string | null; // free-text passthrough (no enum)
}

// One REPORTED genomic variant extracted from a clinical genetics / PGx report
// (#709). These are the PRE-persist AI shapes: result_type / significance /
// zygosity stay as the model's raw strings (normalized to the CHECK sets in
// import-shape via lib/genomic-variant), `gene` is required (a variant with no gene
// anchor is dropped), and the report date is coerced to strict ISO-or-null. Stored
// factually — the extractor captures WHAT the report concluded, never re-interprets
// raw calls, and never adds risk editorializing.
export interface ExtractedGenomicVariant {
  gene: string; // HGNC symbol (required)
  variant: string | null; // rsID and/or HGVS
  genotype: string | null;
  star_allele: string | null;
  zygosity: string | null; // raw; normalized in import-shape
  significance: string | null; // raw ACMG term; normalized in import-shape
  result_type: string | null; // raw; normalized in import-shape (→ 'other' default)
  interpretation: string | null; // the report's own text, verbatim
  source_lab: string | null;
  report_date: string | null; // YYYY-MM-DD
}

// One imaging STUDY extracted from an uploaded radiology report (#702). These are
// the PRE-persist AI shapes: modality / laterality stay as the model's raw strings
// (normalized to the CHECK sets in import-shape via lib/imaging-study), `contrast`
// stays a raw string/boolean (coerced downstream), and the study date is coerced to
// strict ISO-or-null. `impression` is the radiologist's report body, captured
// verbatim; `indication` is the reason the study was ordered. Image pixels / DICOM
// are out of scope — the extractor reads the REPORT, never the images.
export interface ExtractedImagingStudy {
  modality: string | null; // raw; normalized in import-shape (→ 'other' default)
  body_region: string | null;
  laterality: string | null; // raw; normalized in import-shape
  contrast: string | null; // raw ("with"/"without"/…); coerced to bool in import-shape
  contrast_agent: string | null;
  study_date: string | null; // YYYY-MM-DD
  impression: string | null; // the radiologist's report body, verbatim
  indication: string | null; // reason the study was ordered
  status: string | null; // free-text passthrough (no enum)
}

// One optical (eyeglass/contact) prescription extracted from an uploaded Rx slip or
// eye-exam report (#697). These are the PRE-persist AI shapes: `kind` stays the
// model's raw string (normalized to the enum in import-shape via
// lib/optical-prescription), the per-eye powers / axis / distances stay raw strings
// (parsed downstream — an Rx uses "+1.25", "plano", "DS"), and the issued/expiry
// dates are coerced to strict ISO-or-null. `prescriber` is the optometrist's name,
// resolved into the shared providers registry on persist. A printed Rx slip is
// bounded and highly structured — good extraction territory.
export interface ExtractedOpticalPrescription {
  kind: string | null; // raw ("glasses"/"contacts"/…); normalized in import-shape
  od_sphere: string | null; // right eye; raw dioptre string
  od_cylinder: string | null;
  od_axis: string | null;
  od_add: string | null;
  os_sphere: string | null; // left eye
  os_cylinder: string | null;
  os_axis: string | null;
  os_add: string | null;
  pd: string | null; // pupillary distance, mm
  base_curve: string | null; // contacts only
  diameter: string | null; // contacts only
  brand: string | null; // contacts only
  issued_date: string | null; // YYYY-MM-DD
  expiry_date: string | null; // YYYY-MM-DD
  prescriber: string | null; // prescribing optometrist (resolved on persist)
  notes: string | null;
}

// One dental procedure/finding extracted from an uploaded dental exam/treatment
// record or after-visit summary (#705). PRE-persist AI shape: `status`/`tooth_system`
// stay raw (normalized in import-shape via lib/dental); tooth/surface/cdt_code/finding
// pass through as free text; the date is coerced to strict ISO-or-null.
export interface ExtractedDentalProcedure {
  name: string | null; // the procedure or finding ("Composite filling", "Caries watch")
  status: string | null; // raw ("completed"/"planned"/"watch"/…); normalized downstream
  tooth: string | null; // tooth designation ("14", "#14", "UL6")
  tooth_system: string | null; // raw ("universal"/"fdi"/"palmer"); normalized downstream
  surface: string | null; // surface code ("MOD", "buccal")
  cdt_code: string | null; // CDT/ADA procedure code ("D2392")
  procedure_date: string | null; // YYYY-MM-DD
  finding: string | null; // free-text exam impression
  follow_up_interval_days: number | null; // recommended recheck cadence, when stated
}

export interface ExtractionMeta {
  document_type: string | null; // lab | dexa | imaging | immunization | other
  source: string | null;
  patient_name: string | null;
  patient_sex: Sex | null; // the patient's stated sex, when the document gives it
  patient_birthdate: string | null; // the patient's DOB (YYYY-MM-DD), when stated
  patient_age: number | null; // the patient's age in years, when stated without a DOB
  document_date: string | null; // YYYY-MM-DD
}

export type ExtractionResult =
  | {
      status: "done";
      meta: ExtractionMeta;
      results: ExtractedResult[];
      immunizations: ExtractedImmunization[];
      conditions: ExtractedCondition[];
      allergies: ExtractedAllergy[];
      procedures: ExtractedProcedure[];
      encounters: ExtractedEncounter[];
      familyHistory: ExtractedFamilyHistory[];
      carePlanItems: ExtractedCarePlanItem[];
      careGoals: ExtractedCareGoal[];
      // Genomic variants from a clinical genetics / PGx report (#709). Optional so
      // existing done-result fixtures need no change; the real extract path always
      // sets it (empty for a non-genetics document), and import-shape reads it with
      // a `?? []` fallback.
      genomicVariants?: ExtractedGenomicVariant[];
      // Imaging studies from an uploaded radiology report (#702). Optional so
      // existing done-result fixtures need no change; the real extract path always
      // sets it (empty for a non-imaging document), and import-shape reads it with a
      // `?? []` fallback.
      imagingStudies?: ExtractedImagingStudy[];
      // Optical prescriptions from an uploaded Rx slip / eye-exam report (#697).
      // Optional for the same reason; the real extract path always sets it (empty for
      // a non-optical document), and import-shape reads it with a `?? []` fallback.
      opticalPrescriptions?: ExtractedOpticalPrescription[];
      // Dental procedures/findings from an uploaded dental exam/treatment record
      // (#705). Optional so existing done-result fixtures need no change; the real
      // extract path always sets it (empty for a non-dental document), and
      // import-shape reads it with a `?? []` fallback.
      dentalProcedures?: ExtractedDentalProcedure[];
      // Row-level drops (a clinical entity the model emitted but that was rejected
      // for want of its required identifier) — the AI path's drop accounting, folded
      // into a real ImportReport in import-shape. Parity with the deterministic
      // importer, which was previously the only path with a report.
      drops: ImportDrop[];
      // Source-text reconciliation of `results` against the original PDF (text layer
      // or OCR). Set only by the live extract path for a PDF; absent on the replay
      // path (resultFromExtractionInput, which has no buffer) and for non-PDF sources.
      // import-shape folds its summary into the ImportReport.
      reconciliation?: ReconcileReport | null;
      model: string;
      raw: string;
    }
  | { status: "skipped"; message: string }
  | { status: "failed"; error: string };
