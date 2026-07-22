// The medical-record categories and clinical flags, shared by the record forms,
// the category filter, the medical write action, and the AI extractor so the
// option/accept sets can't drift. Pure data (client- and server-safe).
//
// MEDICAL_CATEGORIES is the full enum (mirrors lib/types.ts MedicalCategory and
// the medical_records CHECK — migration 090 grew it to include the #1076 classes).
// BIOMARKER_CATEGORIES is the set the Biomarkers BROWSER (/results/biomarkers, a flat
// catalog) can list/filter/add. It drops the #1076 re-homed classes that HAVE a
// dedicated home:
//   • 'prescription' — medications; live on the document view + Supplements & Meds.
//   • 'biomarker'  — the legacy pre-#1076 bucket, now emptied of real labs.
//   • 'instrument' — screening scores → mental-health / substance-use (SENSITIVITY:
//     a depression/alcohol score must never surface in a general health catalog).
//   • 'derived'    — bio-age composites → the Longevity bio-age hero.
//   • 'reference'  — immutable facts → the passport.
// 'vitals' STAYS browsable here on purpose (#1076): the physiologic vitals gained a
// Trends → Vitals trend home, but the DOMAIN vitals catalogued here — audiogram
// hearing thresholds (#713), intraocular pressure / visual acuity (#697), periodontal
// depth (#705) — have no dedicated chart surface in this codebase, so the flat
// biomarker catalog remains their reachable home; removing them would STRAND them
// (the issue's own "nothing stranded" rule). The TRAJECTORY tab (Trends → Biomarkers)
// separately scopes to lab-only — that is where the years-axis grammar lives. 'genomics'
// and 'scan' are out of #1076's scope and stay browsable (numeric DEXA measurements).
import type { MedicalCategory, MedicalFlag } from "@/lib/types";

export const MEDICAL_CATEGORIES = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
  "instrument",
  "derived",
  "reference",
] as const satisfies readonly MedicalCategory[];

export const BIOMARKER_CATEGORIES = [
  "lab",
  "vitals",
  "genomics",
  "scan",
] as const satisfies readonly MedicalCategory[];

// The complement of BIOMARKER_CATEGORIES — the categories the Biomarkers browser
// EXCLUDES (#1076): the re-homed classes with a dedicated home (instruments, derived
// bio-age, immutable facts) plus the emptied legacy bucket and prescriptions. Kept as
// the derived complement so the two sets can't drift. (Physiologic-vitals TRAJECTORY
// scoping is a separate, tab-local exclusion in Trends → Biomarkers.)
export const NON_BIOMARKER_CATEGORIES = MEDICAL_CATEGORIES.filter(
  (c) => !(BIOMARKER_CATEGORIES as readonly MedicalCategory[]).includes(c)
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
