// Response-parsing / record-mapping stage: coerce the model's raw tool input
// into typed extraction records, plus the patient-metadata normalizers.
import type { MedicalCategory, MedicalFlag, Sex } from "../types";
import type { ImportDrop } from "../import-report";
import { strOrNull } from "../parse";
import { isRealIsoDate } from "../date";
import {
  buildCanonicalIndex,
  snapCanonicalName,
  distinguishVitaminDIsoform,
} from "../canonical-name";
import { CATEGORIES, FLAGS } from "./constants";
import type {
  ExtractedPrescription,
  ExtractedResult,
  ExtractedImmunization,
  ExtractedCondition,
  ExtractedAllergy,
  ExtractedProcedure,
  ExtractedEncounter,
  ExtractedFamilyHistory,
  ExtractedCarePlanItem,
  ExtractedCareGoal,
  ExtractedGenomicVariant,
  ExtractedImagingStudy,
} from "./types";

// The tool schema's TOP-LEVEL property names (the `save_medical_data` input_schema
// in ./prompt). Every normalizer below reads the payload off these keys, so their
// presence is what identifies "this object IS the extraction payload". Keep in sync
// with TOOL.input_schema.properties.
const EXTRACTION_TOP_LEVEL_KEYS = new Set([
  "document_type",
  "source",
  "patient_name",
  "patient_sex",
  "patient_birthdate",
  "patient_age",
  "document_date",
  "results",
  "immunizations",
  "conditions",
  "allergies",
  "procedures",
  "encounters",
  "family_history",
  "care_plan",
  "care_goals",
  "genomic_variants",
  "imaging_studies",
]);

// Whether an object carries the extraction payload — i.e. names at least one of the
// tool schema's top-level keys. Used both to recognize a nested payload and to tell
// a MISSHAPEN response apart from a genuinely empty one (a document with nothing to
// extract still answers with the schema's keys and empty arrays).
export function looksLikeExtractionInput(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).some((k) => EXTRACTION_TOP_LEVEL_KEYS.has(k));
}

// Lift the payload out of a wrapper object the model nested it under.
//
// The tool schema is FLAT ({document_type, results, …}), but a model sometimes
// answers with the whole payload wrapped in one envelope key
// ({document_data: {document_type, results, …}}). Nothing downstream reads that
// shape — every normalizer does `raw?.results` etc. — so the wrapper silently
// yielded ZERO records with no error: indistinguishable from an empty document.
//
// Deliberately CONSERVATIVE: only unwraps when the outer object names none of the
// schema's keys AND exactly one of its values is itself a recognizable payload. An
// already-correct input is returned untouched, and an ambiguous object (several
// payload-shaped values) is left alone for the caller's shape guard to reject
// rather than guessing which one to take.
export function unwrapExtractionInput(input: unknown): unknown {
  if (looksLikeExtractionInput(input)) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const nested = Object.values(input).filter(looksLikeExtractionInput);
  return nested.length === 1 ? nested[0] : input;
}

// Normalize a document's stated sex/gender ("M", "Female", "MALE", …) to our
// canonical Sex, or null when absent/unrecognized (e.g. "unknown", "other").
export function normalizeSex(raw: unknown): Sex | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "m" || s === "male" || s === "man") return "male";
  if (s === "f" || s === "female" || s === "woman") return "female";
  return null;
}

// Accept a birthdate only in strict ISO YYYY-MM-DD form; anything else (a bare
// year, a locale-formatted date, junk) is dropped rather than guessed.
export function normalizeBirthdate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Normalize a stated age to a plausible whole number of years, from either a
// number or a numeric string ("45", "45 years"). Null when absent/implausible.
export function normalizeAge(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? parseInt(raw, 10)
        : NaN;
  return Number.isFinite(n) && n > 0 && n < 150 ? Math.round(n) : null;
}

// Coerce the model's structured `prescription` object into a typed
// ExtractedPrescription, or null when absent/empty (#414). Kept pure + exported so
// the shape coercion is unit-testable. Dates are coerced to strict ISO-or-null; prn
// collapses a boolean/0/1/yes-no to 1/0/null; every text field is trimmed-or-null.
// Returns null when the object carries NO usable field, so an all-null object never
// masks the parsePrescription fallback.
export function normalizePrescription(
  raw: unknown
): ExtractedPrescription | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const rx: ExtractedPrescription = {
    sig: strOrNull(p.sig),
    strength: strOrNull(p.strength),
    prn: boolIntOrNull(p.prn),
    prescriber: strOrNull(p.prescriber),
    pharmacy: strOrNull(p.pharmacy),
    rx_number: strOrNull(p.rx_number),
    start_date: isoDateOrNull(p.start_date),
  };
  const hasAny =
    rx.sig != null ||
    rx.strength != null ||
    rx.prn != null ||
    rx.prescriber != null ||
    rx.pharmacy != null ||
    rx.rx_number != null ||
    rx.start_date != null;
  return hasAny ? rx : null;
}

export function normalizeResults(
  raw: any,
  knownCanonical: string[] = []
): ExtractedResult[] {
  const arr = Array.isArray(raw?.results) ? raw.results : [];
  const out: ExtractedResult[] = [];
  // The model is asked to reuse a canonical name but frequently mirrors the
  // report's spelling instead; snap it back onto the known vocabulary in code
  // so cross-document grouping doesn't depend on the model being consistent.
  const canonicalIndex = buildCanonicalIndex(knownCanonical);
  for (const r of arr) {
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    const category: MedicalCategory = CATEGORIES.includes(r?.category)
      ? r.category
      : "lab";
    const flag: MedicalFlag | null = FLAGS.includes(r?.flag) ? r.flag : null;
    const valueNum =
      typeof r?.value_num === "number" && Number.isFinite(r.value_num)
        ? r.value_num
        : null;
    const str = strOrNull;
    // Fall back to the raw name when the model omits or blanks the canonical.
    // Recover the D2/D3 vitamin-D isoform from the verbatim lab name first (the
    // model tends to drop it and collapse both metabolites onto one series),
    // then snap onto a matching vocabulary entry when one exists.
    const canonicalName = snapCanonicalName(
      distinguishVitaminDIsoform(str(r?.canonical_name) ?? name, name),
      canonicalIndex
    );
    out.push({
      category,
      panel: str(r?.panel),
      name,
      canonical_name: canonicalName,
      value: str(r?.value),
      value_num: valueNum,
      unit: str(r?.unit),
      reference_range: str(r?.reference_range),
      flag,
      collected_date: str(r?.collected_date),
      notes: str(r?.notes),
      // Only a medication result carries structured prescription fields (#414);
      // anything the model attached to a lab/scan row is ignored.
      prescription:
        category === "prescription"
          ? normalizePrescription(r?.prescription)
          : null,
    });
  }
  return out;
}

// Normalize the model's immunizations array into typed entries. Light-touch:
// vaccine-name matching and date validation happen downstream in
// lib/immunization-extract (shared with the manual path); here we only coerce
// shapes and drop entries with no vaccine name.
export function normalizeImmunizations(raw: any): ExtractedImmunization[] {
  const arr = Array.isArray(raw?.immunizations) ? raw.immunizations : [];
  const out: ExtractedImmunization[] = [];
  for (const it of arr) {
    const vaccine = typeof it?.vaccine === "string" ? it.vaccine.trim() : "";
    if (!vaccine) continue;
    out.push({
      vaccine,
      date: strOrNull(it?.date),
      dose_label: strOrNull(it?.dose_label),
      notes: strOrNull(it?.notes),
    });
  }
  return out;
}

// Coerce a model-supplied date to strict ISO YYYY-MM-DD, else null. The DB stores
// dates as ISO strings, so a bare year / locale format / junk is dropped (a null
// date column) rather than guessed.
function isoDateOrNull(raw: unknown): string | null {
  const s = strOrNull(raw);
  return s && isRealIsoDate(s) ? s : null;
}

// A finite number from a number or numeric string, else null (family-history onset age).
function finiteOrNull(raw: unknown): number | null {
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

// The model may report `deceased` as a boolean, 0/1, or a yes/no string; collapse
// to the DB's 1/0/null. Unknown → null (not "alive").
function boolIntOrNull(raw: unknown): number | null {
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0) return 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "yes" || v === "y" || v === "deceased") return 1;
    if (v === "false" || v === "no" || v === "n" || v === "alive") return 0;
  }
  return null;
}

// Normalize the model's clinical-narrative arrays (conditions / allergies /
// procedures / encounters / family history / care plan / care goals) into typed
// entries, collecting an ImportDrop for every entry rejected for want of its
// required identifier (name / substance / condition / description / visit date).
// This is the AI path's strict validator + drop accounting: garbage entries drop
// with a reported reason rather than being silently dropped or silently landed.
// Status-enum normalization and provider resolution happen downstream in
// import-shape (extractionToPersistInput); this stays a pure shape coercion.
export function normalizeClinicalDomains(raw: any): {
  conditions: ExtractedCondition[];
  allergies: ExtractedAllergy[];
  procedures: ExtractedProcedure[];
  encounters: ExtractedEncounter[];
  familyHistory: ExtractedFamilyHistory[];
  carePlanItems: ExtractedCarePlanItem[];
  careGoals: ExtractedCareGoal[];
  genomicVariants: ExtractedGenomicVariant[];
  imagingStudies: ExtractedImagingStudy[];
  drops: ImportDrop[];
} {
  const drops: ImportDrop[] = [];
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  const conditions: ExtractedCondition[] = [];
  for (const c of arr(raw?.conditions)) {
    const name = strOrNull(c?.name);
    if (!name) {
      drops.push({
        kind: "condition",
        label: "(unnamed condition)",
        reason: "no_value",
      });
      continue;
    }
    conditions.push({
      name,
      code: strOrNull(c?.code),
      code_system: strOrNull(c?.code_system),
      status: strOrNull(c?.status),
      onset_date: isoDateOrNull(c?.onset_date),
      resolved_date: isoDateOrNull(c?.resolved_date),
    });
  }

  const allergies: ExtractedAllergy[] = [];
  for (const a of arr(raw?.allergies)) {
    const substance = strOrNull(a?.substance);
    if (!substance) {
      drops.push({
        kind: "allergy",
        label: "(unnamed allergy)",
        reason: "no_value",
      });
      continue;
    }
    allergies.push({
      substance,
      substance_code: strOrNull(a?.substance_code),
      substance_code_system: strOrNull(a?.substance_code_system),
      reaction: strOrNull(a?.reaction),
      severity: strOrNull(a?.severity),
      status: strOrNull(a?.status),
      onset_date: isoDateOrNull(a?.onset_date),
    });
  }

  const procedures: ExtractedProcedure[] = [];
  for (const p of arr(raw?.procedures)) {
    const name = strOrNull(p?.name);
    if (!name) {
      drops.push({
        kind: "procedure",
        label: "(unnamed procedure)",
        reason: "no_value",
      });
      continue;
    }
    procedures.push({
      name,
      code: strOrNull(p?.code),
      code_system: strOrNull(p?.code_system),
      date: isoDateOrNull(p?.date),
    });
  }

  const encounters: ExtractedEncounter[] = [];
  for (const e of arr(raw?.encounters)) {
    // A visit MUST carry a resolvable date (the encounters.date column is NOT NULL);
    // a dateless entry can't be placed on the timeline, so it drops.
    const date = isoDateOrNull(e?.date);
    if (!date) {
      drops.push({
        kind: "encounter",
        label: strOrNull(e?.type) ?? "(undated visit)",
        reason: "no_value",
      });
      continue;
    }
    encounters.push({
      date,
      end_date: isoDateOrNull(e?.end_date),
      type: strOrNull(e?.type),
      class_code: strOrNull(e?.class_code),
      reason: strOrNull(e?.reason),
      diagnoses: arr(e?.diagnoses)
        .map((d) => strOrNull(d))
        .filter((d): d is string => !!d),
      provider: strOrNull(e?.provider),
      location: strOrNull(e?.location),
      notes: strOrNull(e?.notes),
    });
  }

  const familyHistory: ExtractedFamilyHistory[] = [];
  for (const f of arr(raw?.family_history)) {
    const condition = strOrNull(f?.condition);
    if (!condition) {
      drops.push({
        kind: "family_history",
        label: strOrNull(f?.relation) ?? "(family history)",
        reason: "no_value",
      });
      continue;
    }
    familyHistory.push({
      relation: strOrNull(f?.relation),
      condition,
      code: strOrNull(f?.code),
      code_system: strOrNull(f?.code_system),
      onset_age: finiteOrNull(f?.onset_age),
      deceased: boolIntOrNull(f?.deceased),
    });
  }

  const carePlanItems: ExtractedCarePlanItem[] = [];
  for (const c of arr(raw?.care_plan)) {
    const description = strOrNull(c?.description);
    if (!description) {
      drops.push({
        kind: "care_plan",
        label: "(care plan item)",
        reason: "no_value",
      });
      continue;
    }
    carePlanItems.push({
      description,
      code: strOrNull(c?.code),
      code_system: strOrNull(c?.code_system),
      category: strOrNull(c?.category),
      planned_date: isoDateOrNull(c?.planned_date),
      status: strOrNull(c?.status),
    });
  }

  const careGoals: ExtractedCareGoal[] = [];
  for (const g of arr(raw?.care_goals)) {
    const description = strOrNull(g?.description);
    if (!description) {
      drops.push({
        kind: "care_goal",
        label: "(care goal)",
        reason: "no_value",
      });
      continue;
    }
    careGoals.push({
      description,
      code: strOrNull(g?.code),
      code_system: strOrNull(g?.code_system),
      target_date: isoDateOrNull(g?.target_date),
      status: strOrNull(g?.status),
    });
  }

  // Genomic variants from a clinical genetics / PGx report (#709). A variant with
  // no gene anchor can't be stored (the gene column is NOT NULL) and drops, exactly
  // like a nameless condition. result_type / significance / zygosity stay raw here
  // (normalized to the CHECK sets downstream in import-shape); the report date is
  // coerced to strict ISO-or-null; the interpretation text is kept verbatim.
  const genomicVariants: ExtractedGenomicVariant[] = [];
  for (const g of arr(raw?.genomic_variants)) {
    const gene = strOrNull(g?.gene);
    if (!gene) {
      drops.push({
        kind: "genomic_variant",
        label: strOrNull(g?.variant) ?? "(unnamed variant)",
        reason: "no_value",
      });
      continue;
    }
    genomicVariants.push({
      gene,
      variant: strOrNull(g?.variant),
      genotype: strOrNull(g?.genotype),
      star_allele: strOrNull(g?.star_allele),
      zygosity: strOrNull(g?.zygosity),
      significance: strOrNull(g?.significance),
      result_type: strOrNull(g?.result_type),
      interpretation: strOrNull(g?.interpretation),
      source_lab: strOrNull(g?.source_lab),
      report_date: isoDateOrNull(g?.report_date),
    });
  }

  // Imaging studies from an uploaded radiology report (#702). A study with NO
  // impression, NO body region, AND no recognizable modality string is noise and
  // drops (nothing meaningful to store). modality / laterality / contrast stay raw
  // here (normalized to the CHECK sets downstream in import-shape); the study date
  // is coerced to strict ISO-or-null; the impression + indication text are kept
  // verbatim. Image pixels / DICOM are out of scope — this is the REPORT only.
  const imagingStudies: ExtractedImagingStudy[] = [];
  for (const s of arr(raw?.imaging_studies)) {
    const modality = strOrNull(s?.modality);
    const bodyRegion = strOrNull(s?.body_region);
    const impression = strOrNull(s?.impression);
    if (!modality && !bodyRegion && !impression) {
      drops.push({
        kind: "imaging_study",
        label: strOrNull(s?.body_region) ?? "(empty study)",
        reason: "no_value",
      });
      continue;
    }
    imagingStudies.push({
      modality,
      body_region: bodyRegion,
      laterality: strOrNull(s?.laterality),
      contrast: strOrNull(s?.contrast),
      contrast_agent: strOrNull(s?.contrast_agent),
      study_date: isoDateOrNull(s?.study_date),
      impression,
      indication: strOrNull(s?.indication),
      status: strOrNull(s?.status),
    });
  }

  return {
    conditions,
    allergies,
    procedures,
    encounters,
    familyHistory,
    carePlanItems,
    careGoals,
    genomicVariants,
    imagingStudies,
    drops,
  };
}
