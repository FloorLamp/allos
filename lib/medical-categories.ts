// The medical-record categories, shared by the record forms and the category
// filter so the option sets can't drift. Pure data (client- and server-safe).
//
// MEDICAL_CATEGORIES is the full enum (mirrors lib/types.ts MedicalCategory and
// the lib/db.ts CHECK). BIOMARKER_CATEGORIES drops 'prescription': prescriptions
// are medications and don't belong in the Biomarkers browser — they stay on the
// document detail view and Supplements & Meds. No schema/enum change; this only
// governs which categories the Biomarkers UI can list, filter, or add.
export const MEDICAL_CATEGORIES = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
] as const;

export const BIOMARKER_CATEGORIES = MEDICAL_CATEGORIES.filter(
  (c) => c !== "prescription"
);
