// The medical-record categories and clinical flags, shared by the record forms,
// the category filter, the medical write action, and the AI extractor so the
// option/accept sets can't drift. Pure data (client- and server-safe).
//
// MEDICAL_CATEGORIES is the full enum (mirrors lib/types.ts MedicalCategory and
// the lib/db.ts CHECK). BIOMARKER_CATEGORIES drops 'prescription': prescriptions
// are medications and don't belong in the Biomarkers browser — they stay on the
// document detail view and Supplements & Meds. No schema/enum change; this only
// governs which categories the Biomarkers UI can list, filter, or add.
import type { MedicalCategory, MedicalFlag } from "@/lib/types";

export const MEDICAL_CATEGORIES = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
] as const satisfies readonly MedicalCategory[];

export const BIOMARKER_CATEGORIES = MEDICAL_CATEGORIES.filter(
  (c) => c !== "prescription"
);

// The clinical flags a lab report can carry, and the only flags the AI extractor
// is allowed to emit / the write action accepts. The derived "non-optimal*"
// values in MedicalFlag (see lib/types.ts) are intentionally NOT here: they're
// reconciled in code from the canonical optimal band, never set by the lab or
// the model. Shared so the extractor's tool enum and the action's accept-list
// can't drift.
export const MEDICAL_FLAGS = [
  "normal",
  "high",
  "low",
  "abnormal",
] as const satisfies readonly MedicalFlag[];
