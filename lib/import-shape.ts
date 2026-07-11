import type {
  AllergyStatus,
  ConditionStatus,
  MedicalCategory,
  MedicalFlag,
  Sex,
} from "./types";
import type { ExtractionResult } from "./medical-extract";
import type {
  ImportResult,
  ImportedProvider,
  ImportedMedicationCourse,
} from "./health-import";
import { serializeImportReport } from "./import-report";
import { isRealIsoDate } from "./date";
import {
  bodyMetricsFromExtraction,
  bodyMetricsFromReadings,
  bodyMetricKind,
  type DocBodyMetric,
} from "./body-metric-extract";
import {
  heightsFromExtraction,
  heightsFromReadings,
  isHeightReading,
  type DocHeight,
} from "./height-extract";
import {
  headCircsFromExtraction,
  headCircsFromReadings,
  isHeadCircReading,
  type DocHeadCirc,
} from "./head-circ-extract";
import { immunizationsFromExtraction } from "./immunization-extract";

// The one canonical shape a parsed document is reduced to before it is written.
// Both extraction paths — the AI document extractor (rich: panel/flag/reference
// range) and the deterministic CCD/XDM/SHC parser (external_id/source dedup) —
// map into this, so a single persist core (lib/import-persist) does every insert.
// Keeping the adapters here, free of any DB import, makes them unit-testable.

export interface PersistRecord {
  category: MedicalCategory;
  name: string;
  canonical: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  date: string; // YYYY-MM-DD (already resolved — no today() fallback downstream)
  reference_range: string | null;
  flag: MedicalFlag | null;
  panel: string | null;
  notes: string | null;
  source: string | null;
  external_id: string | null;
  // LOINC when the source carried one (deterministic CCD/FHIR path). Not stored on
  // medical_records — it's only used to route/deduplicate body-height readings into
  // metric_samples (see withoutCapturedHeights). The AI path leaves it null.
  loinc: string | null;
  // The performing provider (CCD observation <performer>), resolved into the
  // shared registry and linked via provider_id. Null on the AI path.
  provider: ImportedProvider | null;
  // Derived medication COURSES, set only on prescription records by
  // the deterministic CCD/FHIR path; null/absent on the AI path (which has no
  // structured period/status). The persist layer creates medication_courses from
  // these. Optional so existing PersistRecord constructors need no change.
  courses?: ImportedMedicationCourse[] | null;
  // Structured medication attribution (prescriber / pharmacy / Rx number) resolved
  // by the deterministic CCD/FHIR mappers; threaded into the auto-structured
  // intake_items row so an imported medication carries the source's own attribution
  // instead of always NULL (#417). Null/absent on the AI path.
  prescriber?: string | null;
  pharmacy?: string | null;
  rxNumber?: string | null;
}

export interface PersistImmunization {
  date: string;
  vaccine: string; // catalog/combo/slug code
  dose_label: string | null;
  notes: string | null;
  external_id: string | null;
  // The administering provider (CCD <performer>), resolved + linked.
  provider: ImportedProvider | null;
}

// Allergy / condition projections. The deterministic CCD path fills
// these; the AI path leaves them empty (no allergy/problem extraction yet).
export interface PersistAllergy {
  substance: string;
  substance_code: string | null;
  substance_code_system: string | null;
  reaction: string | null;
  severity: string | null;
  status: AllergyStatus;
  onset_date: string | null;
  external_id: string | null;
}

export interface PersistCondition {
  name: string;
  code: string | null;
  code_system: string | null;
  status: ConditionStatus;
  onset_date: string | null;
  resolved_date: string | null;
  external_id: string | null;
}

// Encounter / visit projection. The deterministic CCD path fills
// these; the AI path leaves them empty. The attending clinician (`provider`) and
// the facility (`location`) are resolved into the shared registry on persist. The
// diagnoses list is stored as a joined summary column on the encounters row.
export interface PersistEncounter {
  date: string;
  end_date: string | null;
  type: string | null;
  class_code: string | null;
  reason: string | null;
  diagnoses: string[];
  provider: ImportedProvider | null;
  location: ImportedProvider | null;
  notes: string | null;
  external_id: string | null;
}

// Procedure + family-history projections. The deterministic CCD/FHIR path fills
// these; the AI path leaves them empty. A procedure's performing clinician
// (`provider`) is resolved into the shared registry on persist.
export interface PersistProcedure {
  name: string;
  code: string | null;
  code_system: string | null;
  date: string | null;
  provider: ImportedProvider | null;
  external_id: string | null;
}

export interface PersistFamilyHistory {
  relation: string | null;
  condition: string;
  code: string | null;
  code_system: string | null;
  onset_age: number | null;
  deceased: number | null;
  external_id: string | null;
}

// Care-plan + care-goal projections. The deterministic CCD/FHIR path fills these;
// the AI path leaves them empty. A care-plan item's ordering clinician (`provider`)
// is resolved into the shared registry on persist.
export interface PersistCarePlanItem {
  description: string;
  code: string | null;
  code_system: string | null;
  category: string | null;
  planned_date: string | null;
  status: string | null;
  provider: ImportedProvider | null;
  external_id: string | null;
}

export interface PersistCareGoal {
  description: string;
  code: string | null;
  code_system: string | null;
  target_date: string | null;
  status: string | null;
  external_id: string | null;
}

// The profile-backfill inputs (sex/birthdate/age/name), shaped for
// adoptProfileFromExtraction. Null when the document states no demographics.
export interface AdoptMeta {
  patient_sex: Sex | null;
  patient_birthdate: string | null;
  patient_age: number | null;
  patient_name: string | null;
}

export interface DocMeta {
  docType: string | null;
  source: string | null;
  documentDate: string | null;
  patientName: string | null;
  raw: string | null;
  model: string | null;
  // The import DEBUGGER report as JSON — what the parse
  // DROPPED + why, and section/resource coverage. Null on the AI extraction path
  // (no structured report). Persisted to medical_documents.import_report.
  importReport: string | null;
}

export interface PersistInput {
  records: PersistRecord[];
  immunizations: PersistImmunization[];
  allergies: PersistAllergy[];
  conditions: PersistCondition[];
  encounters: PersistEncounter[];
  procedures: PersistProcedure[];
  familyHistory: PersistFamilyHistory[];
  carePlanItems: PersistCarePlanItem[];
  careGoals: PersistCareGoal[];
  bodyMetrics: DocBodyMetric[];
  // Body-height samples (metric_samples, metric 'height_cm') — height has no
  // body_metrics column, so it gets its own projection.
  heights: DocHeight[];
  // Head-circumference samples (metric_samples, metric 'head_circumference_cm') —
  // a pediatric anthropometric vital projected exactly like height.
  headCircs: DocHeadCirc[];
  demographics: AdoptMeta | null;
  meta: DocMeta;
  // Canonical names to register in the AI vocabulary. The AI path registers all
  // of its results; the deterministic path registers only lab names (so vital /
  // medication names never enter the biomarker vocabulary).
  canonicalNamesToRegister: string[];
  // Section-level providers to register into the shared registry even when not
  // tied to a specific reading (CCD Care Teams). Per-record/immunization
  // performers ride on those rows; import-persist unions and dedups all of them.
  providers: ImportedProvider[];
}

// Body metrics (weight / body fat % / resting HR) have a single home —
// body_metrics, not medical_records. Drop from `records` a body-metric
// reading only when the projected row for its date actually STORED that measure,
// so it lives in exactly one place. A reading whose kind is a body metric but
// whose value was rejected by the projection's guards (a DEXA "Total Body Fat"
// reported as a mass in kg, an implausible weight/HR) is not in the row, so it
// stays a record rather than vanishing from both tables. A reading with no
// resolvable date (never projected) also stays a record.
function withoutCapturedBodyMetrics(
  records: PersistRecord[],
  bodyMetrics: DocBodyMetric[]
): PersistRecord[] {
  if (bodyMetrics.length === 0) return records;
  const byDate = new Map(bodyMetrics.map((w) => [w.date, w]));
  return records.filter((r) => {
    const kind = bodyMetricKind(r.name, r.canonical);
    if (!kind) return true;
    const row = byDate.get(r.date);
    if (!row) return true;
    const stored =
      kind === "weight"
        ? row.weight_kg
        : kind === "body_fat"
          ? row.body_fat_pct
          : row.resting_hr;
    return stored == null; // keep the record when its measure wasn't stored
  });
}

// Body height has a single home too — metric_samples (metric 'height_cm'), not
// medical_records. Drop from `records` a height reading only when a height
// sample was actually projected for its date. A height whose value was rejected by
// heightToCm's guards (implausible / unknown unit) produced no sample, so it stays
// a record rather than vanishing from both tables — mirroring the weight rule.
// Recognized by LOINC (threaded on the deterministic path) or name/canonical.
function withoutCapturedHeights(
  records: PersistRecord[],
  heights: DocHeight[]
): PersistRecord[] {
  if (heights.length === 0) return records;
  const capturedDates = new Set(heights.map((h) => h.date));
  return records.filter((r) => {
    if (!isHeightReading(r.name, r.canonical, r.loinc)) return true;
    return !capturedDates.has(r.date); // drop when a sample was stored for its date
  });
}

// Head circumference has a single home too — metric_samples (metric
// 'head_circumference_cm'), not medical_records. Drop from `records` a
// head-circ reading only when a sample was actually projected for its date; a
// reading rejected by headCircToCm's guards produced no sample and stays a record.
// Mirrors withoutCapturedHeights exactly.
function withoutCapturedHeadCircs(
  records: PersistRecord[],
  headCircs: DocHeadCirc[]
): PersistRecord[] {
  if (headCircs.length === 0) return records;
  const capturedDates = new Set(headCircs.map((h) => h.date));
  return records.filter((r) => {
    if (!isHeadCircReading(r.name, r.canonical, r.loinc)) return true;
    return !capturedDates.has(r.date); // drop when a sample was stored for its date
  });
}

// AI extraction → PersistInput. `fallbackDate` is the caller-resolved date used
// for results without a real collected_date (document date, else today in the
// profile's timezone); passed in so this stays pure.
export function extractionToPersistInput(
  result: Extract<ExtractionResult, { status: "done" }>,
  fallbackDate: string
): PersistInput {
  const docDate = isRealIsoDate(result.meta.document_date)
    ? result.meta.document_date
    : null;
  const allRecords: PersistRecord[] = result.results.map((r) => ({
    category: r.category,
    name: r.name,
    canonical: r.canonical_name || r.name,
    value: r.value,
    value_num: Number.isFinite(r.value_num) ? r.value_num : null,
    unit: r.unit,
    date: isRealIsoDate(r.collected_date) ? r.collected_date! : fallbackDate,
    reference_range: r.reference_range,
    flag: r.flag,
    panel: r.panel,
    notes: r.notes,
    source: null,
    external_id: null,
    loinc: null,
    provider: null,
    // The AI path carries no structured medication period/status → courses.
    courses: null,
  }));
  const bodyMetrics = bodyMetricsFromExtraction(
    result.results,
    result.meta.document_date
  );
  const heights = heightsFromExtraction(
    result.results,
    result.meta.document_date
  );
  const headCircs = headCircsFromExtraction(
    result.results,
    result.meta.document_date
  );
  const records = withoutCapturedHeadCircs(
    withoutCapturedHeights(
      withoutCapturedBodyMetrics(allRecords, bodyMetrics),
      heights
    ),
    headCircs
  );
  return {
    records,
    immunizations: immunizationsFromExtraction(
      result.immunizations,
      result.meta.document_date
    ).map((im) => ({
      date: im.date,
      vaccine: im.vaccine,
      dose_label: im.dose_label,
      notes: im.notes,
      external_id: null,
      provider: null,
    })),
    // The AI extraction path does not yet emit allergies/problems/encounters/
    // procedures/family-history/care-plan/care-goals — only the deterministic
    // CCD/FHIR path does.
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    bodyMetrics,
    heights,
    headCircs,
    demographics: {
      patient_sex: result.meta.patient_sex,
      patient_birthdate: result.meta.patient_birthdate,
      patient_age: result.meta.patient_age,
      patient_name: result.meta.patient_name,
    },
    meta: {
      docType: result.meta.document_type,
      source: result.meta.source,
      documentDate: docDate,
      patientName: result.meta.patient_name,
      raw: result.raw,
      model: result.model,
      // The AI extraction path produces no structured drop/coverage report.
      importReport: null,
    },
    // Register only the names that stay as records (body metrics aren't
    // biomarkers, so they don't enter the vocabulary).
    canonicalNamesToRegister: records.map((r) => r.canonical),
    // The AI path doesn't surface providers yet.
    providers: [],
  };
}

// Deterministic health-record (CCD/XDM/SHC) ImportResult → PersistInput.
export function healthRecordToPersistInput(
  parsed: ImportResult,
  source: string,
  docTypeLabel: string
): PersistInput {
  const allDates = [
    ...parsed.immunizations.map((i) => i.date),
    ...parsed.records.map((r) => r.date),
  ].sort();
  const docDate = allDates.length ? allDates[allDates.length - 1] : null;
  const allRecords: PersistRecord[] = parsed.records.map((r) => ({
    category: r.category,
    name: r.name,
    canonical: r.canonical,
    value: r.value,
    value_num: r.value_num,
    unit: r.unit,
    date: r.date,
    reference_range: null,
    flag: null,
    panel: null,
    notes: null,
    source,
    external_id: r.external_id,
    loinc: r.loinc ?? null,
    provider: r.provider ?? null,
    // Derived medication courses ride on prescription records.
    courses: r.courses ?? null,
    // Structured attribution rides on prescription records (#417).
    prescriber: r.prescriber ?? null,
    pharmacy: r.pharmacy ?? null,
    rxNumber: r.rxNumber ?? null,
  }));
  // Project body-metric records (weight / body fat / resting HR) into body_metrics
  // — the same single-home rule the AI path uses.
  const bodyMetrics = bodyMetricsFromReadings(
    parsed.records.map((r) => ({
      name: r.name,
      canonical: r.canonical,
      value_num: r.value_num,
      unit: r.unit,
      date: r.date,
    })),
    docDate
  );
  // Project body-height records into metric_samples. LOINC is threaded from
  // the CCD/FHIR mappers, so a height with a generic name still routes correctly.
  const heights = heightsFromReadings(
    parsed.records.map((r) => ({
      name: r.name,
      canonical: r.canonical,
      value_num: r.value_num,
      unit: r.unit,
      date: r.date,
      loinc: r.loinc ?? null,
    })),
    docDate
  );
  // Project head-circumference records into metric_samples. LOINC (8287-5 /
  // 9843-4) is threaded from the CCD mappers, so an OFC reading routes correctly
  // even under a generic display name; the percentile code 8289-1 is not a
  // head-circ LOINC and so is never projected.
  const headCircs = headCircsFromReadings(
    parsed.records.map((r) => ({
      name: r.name,
      canonical: r.canonical,
      value_num: r.value_num,
      unit: r.unit,
      date: r.date,
      loinc: r.loinc ?? null,
    })),
    docDate
  );
  const records = withoutCapturedHeadCircs(
    withoutCapturedHeights(
      withoutCapturedBodyMetrics(allRecords, bodyMetrics),
      heights
    ),
    headCircs
  );
  return {
    records,
    immunizations: parsed.immunizations.map((im) => ({
      date: im.date,
      vaccine: im.code,
      dose_label: im.dose_label,
      notes: im.notes,
      external_id: im.external_id,
      provider: im.provider ?? null,
    })),
    allergies: (parsed.allergies ?? []).map((a) => ({
      substance: a.substance,
      substance_code: a.substance_code,
      substance_code_system: a.substance_code_system,
      reaction: a.reaction,
      severity: a.severity,
      status: a.status,
      onset_date: a.onset_date,
      external_id: a.external_id,
    })),
    conditions: (parsed.conditions ?? []).map((c) => ({
      name: c.name,
      code: c.code,
      code_system: c.code_system,
      status: c.status,
      onset_date: c.onset_date,
      resolved_date: c.resolved_date,
      external_id: c.external_id,
    })),
    encounters: (parsed.encounters ?? []).map((e) => ({
      date: e.date,
      end_date: e.end_date,
      type: e.type,
      class_code: e.class_code,
      reason: e.reason,
      diagnoses: e.diagnoses,
      provider: e.provider ?? null,
      location: e.location ?? null,
      notes: e.notes ?? null,
      external_id: e.external_id,
    })),
    procedures: (parsed.procedures ?? []).map((p) => ({
      name: p.name,
      code: p.code,
      code_system: p.code_system,
      date: p.date,
      provider: p.provider ?? null,
      external_id: p.external_id,
    })),
    familyHistory: (parsed.familyHistory ?? []).map((f) => ({
      relation: f.relation,
      condition: f.condition,
      code: f.code,
      code_system: f.code_system,
      onset_age: f.onset_age,
      deceased: f.deceased,
      external_id: f.external_id,
    })),
    carePlanItems: (parsed.carePlanItems ?? []).map((c) => ({
      description: c.description,
      code: c.code,
      code_system: c.code_system,
      category: c.category,
      planned_date: c.planned_date,
      status: c.status,
      provider: c.provider ?? null,
      external_id: c.external_id,
    })),
    careGoals: (parsed.careGoals ?? []).map((g) => ({
      description: g.description,
      code: g.code,
      code_system: g.code_system,
      target_date: g.target_date,
      status: g.status,
      external_id: g.external_id,
    })),
    bodyMetrics,
    heights,
    headCircs,
    demographics: parsed.demographics
      ? {
          patient_sex: parsed.demographics.sex,
          patient_birthdate: parsed.demographics.birthdate,
          patient_age: null,
          patient_name: parsed.demographics.name,
        }
      : null,
    meta: {
      docType: docTypeLabel,
      source,
      documentDate: allDates.length ? allDates[allDates.length - 1] : null,
      patientName: parsed.demographics?.name ?? null,
      raw: JSON.stringify(parsed),
      model: null,
      // The deterministic CCD/FHIR parse carries the drop/coverage report.
      importReport: serializeImportReport(parsed.report),
    },
    canonicalNamesToRegister: parsed.records
      .filter((r) => r.category === "lab")
      .map((r) => r.canonical),
    // Care-team providers (not tied to one reading) — registered so the family's
    // provider list is populated even before a record is manually linked.
    providers: parsed.providers ?? [],
  };
}
