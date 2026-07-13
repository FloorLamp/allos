// Extracted record shapes — the source of truth for what one medical-document
// extraction yields, and the ExtractionResult union the pipeline returns.
import type { MedicalCategory, MedicalFlag, Sex } from "../types";
import type { ImportDrop } from "../import-report";

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
      // Row-level drops (a clinical entity the model emitted but that was rejected
      // for want of its required identifier) — the AI path's drop accounting, folded
      // into a real ImportReport in import-shape. Parity with the deterministic
      // importer, which was previously the only path with a report.
      drops: ImportDrop[];
      model: string;
      raw: string;
    }
  | { status: "skipped"; message: string }
  | { status: "failed"; error: string };
