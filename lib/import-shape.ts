import type {
  AllergyCriticality,
  AllergyStatus,
  AllergyVerificationStatus,
  AppointmentKind,
  AppointmentStatus,
  ConditionLaterality,
  ConditionSeverity,
  ConditionStatus,
  FamilyLineage,
  FamilyRelationType,
  MedicalCategory,
  MedicalFlag,
  Sex,
} from "./types";
import type { ExtractedConfidence, ExtractionResult } from "./medical-extract";
import type {
  ImportResult,
  ImportedProvider,
  ImportedMedicationCourse,
} from "./health-import";
import {
  serializeImportReport,
  isRowDrop,
  keptRowCount,
  tallyUnresolvedNames,
  type ImportDrop,
  type ImportReport,
  type ReconciliationSummary,
} from "./import-report";
import { normalizeDurationValue } from "./duration-value";
import {
  summarizeExtractionConfidence,
  type ConfidenceItem,
  type ConfidenceKind,
} from "./extraction-confidence";
import { recordConfidenceKind } from "./confidence-triage";
import canonicalSeed from "./canonical-biomarkers.json";
import {
  toConditionLaterality,
  toConditionSeverity,
  toConditionStage,
} from "./condition-attributes";
import { toFamilyLineage, toFamilyRelationType } from "./family-relation";
import { normalizeCanonicalKey } from "./canonical-name";
import {
  toAllergyCriticality,
  toAllergyStatus,
  toAllergyVerificationStatus,
  toConditionStatus,
  toImmunizationRoute,
} from "./clinical-parse";
import {
  normalizeResultType,
  normalizeSignificance,
  normalizeZygosity,
} from "./genomic-variant";
import {
  normalizeModality,
  normalizeLaterality,
  normalizeContrast,
  parseDoseMsv,
} from "./imaging-study";
import {
  normalizeOpticalKind,
  parseDiopter,
  parseEyeRefraction,
  parseMillimeters,
} from "./optical-prescription";
import {
  normalizeDentalStatus,
  normalizeToothSystem,
  normalizeTooth,
  normalizeSurface,
} from "./dental";
import type {
  GenomicResultType,
  GenomicSignificance,
  Zygosity,
  ImagingModality,
  ImagingLaterality,
  OpticalKind,
  DentalStatus,
  ToothSystem,
} from "./types/medical";
import { isRealIsoDate } from "./date";
import { carriesBiomarkerIdentity } from "./medical-categories";
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
import {
  waistCircsFromExtraction,
  waistCircsFromReadings,
  isWaistCircReading,
  type DocWaistCirc,
} from "./waist-circ-extract";
import { immunizationsFromExtraction } from "./immunization-extract";

// The curated canonical vocabulary, by normalized key — so the AI path can tell a
// lab reading that landed on a real dataset entry (has a reference band) from one
// that matched nothing and imported under its raw name (#918 §4).
const SEEDED_CANONICAL_KEYS = new Set(
  (canonicalSeed as { biomarkers?: { name: string }[] }).biomarkers?.map((b) =>
    normalizeCanonicalKey(b.name)
  ) ?? []
);
function isSeededCanonical(name: string): boolean {
  return SEEDED_CANONICAL_KEYS.has(normalizeCanonicalKey(name));
}

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
  // The absolute moment the SOURCE stated (#2243), canonical UTC, destined for
  // medical_records.occurred_at. Non-null only when the document carried BOTH a clock
  // time and a zone — a zoneless clinical clock is never resolved against the profile's
  // timezone. Never re-derive `date` from it: the two legitimately disagree across a
  // day boundary and the day attribution (#94) is the one the source stated.
  occurred_at?: string | null;
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
  // The result LIFECYCLE + collection attributes (#1404), when the source states
  // them: FHIR `Observation.status` on the deterministic path, the printed
  // "CORRECTED REPORT" / "Fasting: Yes" / "Specimen: Serum" lines on the AI path.
  // Optional so existing PersistRecord constructors need no change; every adapter
  // sets them (null when the document doesn't say).
  result_status?: string | null;
  fasting?: number | null;
  specimen?: string | null;
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
  // Tier-1 visit link (#1050): the external_id of the Encounter this reading's source
  // referenced (Observation/MedicationRequest.encounter, resolved in-bundle). The
  // persist layer resolves it to the local encounter row and sets encounter_id.
  // Null/absent on the AI path (no encounter references).
  encounter_external_id?: string | null;
  // Tier-1 indication link (#1052): the external_id of the Condition a prescription's
  // MedicationRequest.reasonReference pointed at (resolved in-bundle). The persist
  // layer resolves it to the local condition row and stamps the projected medication's
  // indication_condition_id. Null/absent on the AI path.
  indication_condition_external_id?: string | null;
}

export interface PersistImmunization {
  date: string;
  vaccine: string; // catalog/combo/slug code
  dose_label: string | null;
  notes: string | null;
  // Administration attributes (#1406). Optional so existing PersistInput literals
  // (the DB-tier fixtures) need no change; persist reads them with `?? null`.
  lot_number?: string | null;
  route?: string | null;
  site?: string | null;
  reaction?: string | null;
  external_id: string | null;
  // The administering provider (CCD <performer>), resolved + linked.
  provider: ImportedProvider | null;
  // Tier-1 visit link (#1050): the Encounter this vaccine was given at.
  encounter_external_id?: string | null;
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
  // Safety attributes (#1405), already normalized to the CHECK sets (or null for
  // unstated). Optional so existing PersistInput literals need no change.
  criticality?: AllergyCriticality | null;
  verification_status?: AllergyVerificationStatus | null;
  onset_date: string | null;
  external_id: string | null;
  // Tier-1 visit link (#1526): the Encounter this AllergyIntolerance referenced
  // (AllergyIntolerance.encounter in R4/R5). The persist layer resolves it to the local
  // encounter row and stamps encounter_id, exactly as it does for conditions and
  // procedures. Null/absent on the AI and CDA paths (neither carries the reference).
  encounter_external_id?: string | null;
}

export interface PersistCondition {
  name: string;
  code: string | null;
  code_system: string | null;
  status: ConditionStatus;
  // Side / grade / stage (#1403). Optional: only the deterministic CCD/FHIR path
  // fills them (targetSiteCode / Problem Severity, bodySite / severity); the AI path
  // leaves them unstated, and an absent value is never guessed into a claim.
  laterality?: ConditionLaterality | null;
  severity?: ConditionSeverity | null;
  stage?: string | null;
  onset_date: string | null;
  resolved_date: string | null;
  external_id: string | null;
  // Tier-1 visit-diagnosis link (#1050): the visit this was diagnosed at.
  encounter_external_id?: string | null;
}

// Encounter / visit projection. The deterministic CCD path fills
// these; the AI path leaves them empty. The attending clinician (`provider`) and
// the facility (`location`) are resolved into the shared registry on persist. The
// diagnoses list is stored as a joined summary column on the encounters row.
export interface PersistEncounter {
  date: string;
  end_date: string | null;
  type: string | null;
  // Encounter TYPE code + labeled system (CPT/CDT/SNOMED, #1035). The structured
  // CCD/FHIR path fills these; the AI path leaves them null. Optional so existing
  // PersistInput literals (the DB-tier fixtures) need no change; the persist core
  // writes them with a `?? null` fallback (the genomicVariants precedent).
  code?: string | null;
  code_system?: string | null;
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
  // Tier-1 visit link (#1050): the visit this Procedure.encounter referenced.
  encounter_external_id?: string | null;
}

export interface PersistFamilyHistory {
  relation: string | null;
  condition: string;
  code: string | null;
  code_system: string | null;
  onset_age: number | null;
  deceased: number | null;
  // Death facts + the genetic discriminator (#1407). Optional, same discipline as
  // the condition attributes above: the deterministic path fills what the document
  // states, the AI path leaves them unstated, and unstated relation_type reads as
  // genetic (lib/family-relation.ts).
  age_at_death?: number | null;
  cause_of_death?: string | null;
  relation_type?: FamilyRelationType | null;
  lineage?: FamilyLineage | null;
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

// Genomic-variant projection (#709). The AI report path fills this; the
// deterministic CCD/FHIR path leaves it empty (consumer genotype bundles are #712,
// out of scope, and FHIR genomics-reporting is low-priority — #708). result_type /
// significance / zygosity are already normalized onto the DB CHECK sets here.
export interface PersistGenomicVariant {
  gene: string;
  variant: string | null;
  genotype: string | null;
  star_allele: string | null;
  zygosity: Zygosity | null;
  significance: GenomicSignificance | null;
  result_type: GenomicResultType;
  interpretation: string | null;
  source_lab: string | null;
  report_date: string | null;
  external_id: string | null;
}

// Imaging-study projection (#702). The AI report path fills this; the deterministic
// CCD/FHIR path leaves it empty (FHIR ImagingStudy/DiagnosticReport mapping is #708,
// out of scope). modality / laterality are already normalized onto the DB CHECK sets
// here and `contrast` is coerced to a 0/1-storable boolean.
export interface PersistImagingStudy {
  modality: ImagingModality;
  body_region: string | null;
  laterality: ImagingLaterality | null;
  contrast: boolean;
  contrast_agent: string | null;
  study_date: string | null;
  dose_msv: number | null;
  impression: string | null;
  indication: string | null;
  status: string | null;
  external_id: string | null;
}

// Optical-prescription projection (#697). The AI Rx-slip path fills this; the
// deterministic CCD/FHIR path leaves it empty (FHIR VisionPrescription mapping is
// #708, out of scope). `kind` is already normalized onto the enum here and the
// per-eye powers / axis / distances are parsed to numbers. The `prescriber`
// (optometrist) is resolved into the shared providers registry on persist (linked
// via optical_prescriptions.provider_id).
export interface PersistOpticalPrescription {
  kind: OpticalKind;
  od_sphere: number | null;
  od_cylinder: number | null;
  od_axis: number | null;
  od_add: number | null;
  os_sphere: number | null;
  os_cylinder: number | null;
  os_axis: number | null;
  os_add: number | null;
  pd: number | null;
  base_curve: number | null;
  diameter: number | null;
  brand: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  provider: ImportedProvider | null;
  notes: string | null;
  external_id: string | null;
}

// Dental-procedure projection (#705). Only the AI extractor fills this (dental has no
// FHIR structured feed, #708). `status`/`tooth_system` are normalized here; free-text
// tooth/surface/cdt/finding pass through.
export interface PersistDentalProcedure {
  name: string;
  status: DentalStatus;
  tooth: string | null;
  tooth_system: ToothSystem | null;
  surface: string | null;
  cdt_code: string | null;
  procedure_date: string | null;
  finding: string | null;
  follow_up_interval_days: number | null;
  external_id: string | null;
}

// Scheduled-appointment projection (issue #416). Only the FHIR Appointment resource
// fills this; the AI and CDA paths leave it empty. The attending clinician
// (`provider`) is resolved into the shared registry on persist (linked via
// appointments.provider_id); the facility is a plain `location` string.
export interface PersistAppointment {
  scheduled_at: string;
  status: AppointmentStatus;
  title: string | null;
  location: string | null;
  notes: string | null;
  kind: AppointmentKind | null;
  provider: ImportedProvider | null;
  external_id: string | null;
}

// The profile-backfill inputs (sex/birthdate/age/name), shaped for
// adoptProfileFromExtraction. Null when the document states no demographics.
export interface AdoptMeta {
  patient_sex: Sex | null;
  patient_birthdate: string | null;
  patient_age: number | null;
  patient_name: string | null;
  // The patient's own postal code (CDA header), for the offline ZIP-centroid home
  // location suggestion (issue #570). Optional — only the CCD path populates it.
  patient_postal_code?: string | null;
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
  // Genomic variants (#709). Optional so existing PersistInput literals (the DB-tier
  // fixtures) need no change; the persist core reads it with a `?? []` fallback.
  genomicVariants?: PersistGenomicVariant[];
  // Imaging studies (#702). Optional for the same reason; persist reads it `?? []`.
  imagingStudies?: PersistImagingStudy[];
  // Optical prescriptions (#697). Optional for the same reason; persist reads `?? []`.
  opticalPrescriptions?: PersistOpticalPrescription[];
  // Dental procedures (#705). Optional for the same reason; persist reads it `?? []`.
  dentalProcedures?: PersistDentalProcedure[];
  appointments: PersistAppointment[];
  bodyMetrics: DocBodyMetric[];
  // Body-height samples (metric_samples, metric 'height_cm') — height has no
  // body_metrics column, so it gets its own projection.
  heights: DocHeight[];
  // Head-circumference samples (metric_samples, metric 'head_circumference_cm') —
  // a pediatric anthropometric vital projected exactly like height.
  headCircs: DocHeadCirc[];
  // Waist-circumference samples (metric_samples, metric 'waist_circumference_cm') —
  // the third length measure, projected exactly like the other two (#2322). The
  // projection is what lets the `waist-circ` slug claim the analyte name at all; see
  // METRIC_DOCUMENT_REACH in lib/trend-metric-analytes.ts. OPTIONAL for the same
  // reason genomicVariants / imagingStudies are: an existing PersistInput literal
  // (the DB-tier fixtures) needs no change, and every reader takes it with `?? []`.
  waistCircs?: DocWaistCirc[];
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

// Waist circumference has a single home too — metric_samples (metric
// 'waist_circumference_cm'), not medical_records. Drop from `records` a waist reading
// only when a sample was actually projected for its date; a reading rejected by
// waistCircToCm's guards produced no sample and stays a record. Mirrors
// withoutCapturedHeadCircs exactly.
function withoutCapturedWaistCircs(
  records: PersistRecord[],
  waistCircs: DocWaistCirc[]
): PersistRecord[] {
  if (waistCircs.length === 0) return records;
  const capturedDates = new Set(waistCircs.map((w) => w.date));
  return records.filter((r) => {
    if (!isWaistCircReading(r.name, r.canonical, r.loinc)) return true;
    return !capturedDates.has(r.date); // drop when a sample was stored for its date
  });
}

// Wrap a captured provider/facility NAME (the AI path surfaces these as bare
// strings) into the provider-neutral ImportedProvider the persist layer resolves
// into the shared registry. Null name → null (nothing to register).
function providerFromName(
  name: string | null,
  type: "individual" | "organization"
): ImportedProvider | null {
  const clean = name?.trim();
  if (!clean) return null;
  return {
    name: clean,
    type,
    npi: null,
    identifier: null,
    phone: null,
    address: null,
  };
}

// AI extraction → PersistInput. `fallbackDate` is the caller-resolved date used
// for results without a real collected_date (document date, else today in the
// profile's timezone); passed in so this stays pure.
// Flatten a done extraction into the per-row confidence items the report summary is
// built from (#1601): one item per row the model emitted, in DOCUMENT order, labelled
// with the row's own identity (the analyte / condition / substance …) — the same
// identity the Dropped list uses — so a flagged row can be found on the page.
//
// Exported for the pure tier: this is the ONE place the extraction's shapes are turned
// into confidence items, so the detail card, the Review feed badge, and the tests all
// rank the same list.
export function extractionConfidenceItems(
  result: Extract<ExtractionResult, { status: "done" }>
): ConfidenceItem[] {
  const item = (
    kind: ConfidenceKind,
    label: string,
    row: ExtractedConfidence
  ): ConfidenceItem => ({
    kind,
    label,
    // Already normalized at the extract boundary (normalizeClinicalDomains /
    // normalizeResults); absent on a legacy replay, which is a legitimate "unknown".
    confidence: row.confidence ?? null,
    reason: row.confidence_reason ?? null,
  });
  return [
    // Which kind a records row is flagged under is the SAME question the triage
    // links ask of a persisted row, so both read one answer (#2339) — otherwise a
    // flag and the row it names could disagree about their own domain.
    ...result.results.map((r) =>
      item(recordConfidenceKind(r.category), r.name, r)
    ),
    ...result.immunizations.map((i) => item("immunization", i.vaccine, i)),
    ...result.conditions.map((c) => item("condition", c.name, c)),
    ...result.allergies.map((a) => item("allergy", a.substance, a)),
    ...result.procedures.map((p) => item("procedure", p.name, p)),
    ...result.encounters.map((e) => item("encounter", e.type ?? "Visit", e)),
    ...result.familyHistory.map((f) =>
      item(
        "family_history",
        f.relation ? `${f.relation}: ${f.condition}` : f.condition,
        f
      )
    ),
    ...result.carePlanItems.map((c) => item("care_plan", c.description, c)),
    ...result.careGoals.map((g) => item("care_goal", g.description, g)),
    ...(result.genomicVariants ?? []).map((v) =>
      item("genomic_variant", v.gene, v)
    ),
    ...(result.imagingStudies ?? []).map((s) =>
      item("imaging_study", s.body_region ?? s.modality ?? "Imaging study", s)
    ),
    ...(result.opticalPrescriptions ?? []).map((p) =>
      item("optical_prescription", p.kind ?? "Optical prescription", p)
    ),
    ...(result.dentalProcedures ?? []).map((d) =>
      item("dental_procedure", d.name ?? "Dental record", d)
    ),
  ];
}

export function extractionToPersistInput(
  result: Extract<ExtractionResult, { status: "done" }>,
  fallbackDate: string
): PersistInput {
  const docDate = isRealIsoDate(result.meta.document_date)
    ? result.meta.document_date
    : null;
  // The DURATION door on the AI path (#2322) — the third door, same pure decision as
  // the CDA and FHIR parsers make. The model faithfully reports what the page printed,
  // which for a stress test's `Exercise Duration` is "10:30" in `min:sec`; that is a
  // string, and a string stored as a reading never plots, flags or trends. Normalize
  // it to seconds, or DROP it with a reason — never store it.
  const durationDrops: ImportDrop[] = [];
  const allRecords: PersistRecord[] = result.results.flatMap((r) => {
    // A structured prescription object (#414) supplies the sig / strength /
    // prescriber / pharmacy / Rx / start-date straight off the label, so the med
    // projection no longer depends on parsePrescription reconstructing them from a
    // note. It is preferred; parsePrescription stays the fallback (its conservative
    // "no invented schedule" rule still runs as post-validation on the sig). We
    // route the structured sig into `notes` and the strength into `value` so the
    // existing PersistRecord → parsePrescription path infers the schedule from clean
    // directions rather than the model's free-text note.
    const rx = r.category === "prescription" ? r.prescription : null;
    // Force PRN through the sig so parseSig marks the med as-needed (PRN wins over
    // any frequency token). Otherwise keep the verbatim sig, falling back to the
    // model's note when it didn't structure one.
    const sigNote =
      rx?.prn === 1
        ? [rx.sig, "as needed"].filter(Boolean).join("; ")
        : (rx?.sig ?? r.notes);
    const courses: ImportedMedicationCourse[] | null =
      rx?.start_date != null
        ? [
            {
              started_on: rx.start_date,
              stopped_on: null,
              stop_reason: null,
              notes: null,
            },
          ]
        : null;
    // A `report` row is a narrative document (#708 — an ECG/stress-test/imaging
    // interpretation the model classified as `report`), not a valued analyte: its text
    // belongs in `notes` with a NULL value, matching the CDA report shape that
    // Results → Reports reads (getClinicalReports renders `notes`). The model puts the
    // narrative in `value` (the natural result field), so fold value+notes into one
    // body here — otherwise the report renders with an empty body.
    const isReport = r.category === "report";
    // A `report` row is narrative, so it never carries a unit to declare a duration.
    const duration = isReport
      ? ({ kind: "not-a-duration" } as const)
      : normalizeDurationValue(r.value, r.value_num, r.unit);
    if (duration.kind === "unparsable") {
      durationDrops.push({
        kind: r.category === "vitals" ? "vitals" : "lab",
        label: r.name,
        reason: "unparsable_value",
      });
      return [];
    }
    const stored =
      duration.kind === "normalized"
        ? {
            value: duration.value,
            value_num: duration.value_num,
            unit: duration.unit,
          }
        : {
            value: isReport ? null : (rx?.strength ?? r.value),
            value_num:
              isReport || !Number.isFinite(r.value_num) ? null : r.value_num,
            unit: isReport ? null : r.unit,
          };
    const reportBody = isReport
      ? [r.value, r.notes]
          .map((s) => (s == null ? "" : String(s).trim()))
          .filter(Boolean)
          .join(" — ") || null
      : null;
    return [
      {
        category: r.category,
        name: r.name,
        canonical: r.canonical_name || r.name,
        value: stored.value,
        value_num: stored.value_num,
        unit: stored.unit,
        date: isRealIsoDate(r.collected_date)
          ? r.collected_date!
          : fallbackDate,
        reference_range: r.reference_range,
        flag: r.flag,
        panel: r.panel,
        notes: isReport ? reportBody : rx ? sigNote : r.notes,
        source: null,
        external_id: null,
        loinc: null,
        provider: null,
        // The lifecycle + collection attributes the model read off the page (#1404):
        // a "CORRECTED REPORT" banner, a "Fasting: Yes" line, a printed specimen.
        // Null whenever the document doesn't state one (the persist boundary
        // normalizes an unrecognized word to null rather than guessing).
        result_status: r.result_status ?? null,
        fasting: r.fasting ?? null,
        specimen: r.specimen ?? null,
        // Structured medication period (a single open course from the printed start
        // date) + attribution, when the label carried them (#414); else null and the
        // persist layer's parsePrescription fallback fills what it can.
        courses,
        prescriber: rx?.prescriber ?? null,
        pharmacy: rx?.pharmacy ?? null,
        rxNumber: rx?.rx_number ?? null,
      },
    ];
  });
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
  const waistCircs = waistCircsFromExtraction(
    result.results,
    result.meta.document_date
  );
  const records = withoutCapturedWaistCircs(
    withoutCapturedHeadCircs(
      withoutCapturedHeights(
        withoutCapturedBodyMetrics(allRecords, bodyMetrics),
        heights
      ),
      headCircs
    ),
    waistCircs
  );

  // Clinical-narrative domains (parity with the deterministic importer). The AI path
  // leaves external_id null — a document's rows are cleared/reprocessed by
  // document_id (clearImportedDocumentRows), so reprocess is idempotent without a
  // natural key — matching how the AI path already treats records/immunizations.
  // Status strings are normalized to the CHECK sets here (toAllergyStatus/
  // toConditionStatus); care-plan/care-goal status is free-text passthrough.
  const immunizations = immunizationsFromExtraction(
    result.immunizations,
    result.meta.document_date
  ).map((im) => ({
    date: im.date,
    vaccine: im.vaccine,
    dose_label: im.dose_label,
    notes: im.notes,
    lot_number: im.lot_number ?? null,
    route: toImmunizationRoute(im.route),
    site: im.site ?? null,
    reaction: im.reaction ?? null,
    external_id: null,
    provider: null,
  }));
  const allergies: PersistAllergy[] = result.allergies.map((a) => ({
    substance: a.substance,
    substance_code: a.substance_code,
    substance_code_system: a.substance_code_system,
    reaction: a.reaction,
    severity: a.severity,
    status: toAllergyStatus(a.status),
    criticality: toAllergyCriticality(a.criticality),
    verification_status: toAllergyVerificationStatus(a.verification_status),
    onset_date: a.onset_date,
    external_id: null,
  }));
  const conditions: PersistCondition[] = result.conditions.map((c) => ({
    name: c.name,
    code: c.code,
    code_system: c.code_system,
    status: toConditionStatus(c.status),
    // Side / grade coerced onto the CHECK sets here (#1403), one shared coercion
    // (lib/condition-attributes), so an off-vocabulary model string lands as
    // unstated instead of failing the INSERT. Stage is free text by design.
    laterality: toConditionLaterality(c.laterality),
    severity: toConditionSeverity(c.severity),
    stage: toConditionStage(c.stage),
    onset_date: c.onset_date,
    resolved_date: c.resolved_date,
    external_id: null,
  }));
  const encounters: PersistEncounter[] = result.encounters.map((e) => ({
    date: e.date,
    end_date: e.end_date,
    type: e.type,
    // The AI extraction result carries no structured encounter type coding.
    code: null,
    code_system: null,
    class_code: e.class_code,
    reason: e.reason,
    diagnoses: e.diagnoses,
    provider: providerFromName(e.provider, "individual"),
    location: providerFromName(e.location, "organization"),
    notes: e.notes,
    external_id: null,
  }));
  const procedures: PersistProcedure[] = result.procedures.map((p) => ({
    name: p.name,
    code: p.code,
    code_system: p.code_system,
    date: p.date,
    provider: null,
    external_id: null,
  }));
  const familyHistory: PersistFamilyHistory[] = result.familyHistory.map(
    (f) => ({
      relation: f.relation,
      condition: f.condition,
      code: f.code,
      code_system: f.code_system,
      onset_age: f.onset_age,
      deceased: f.deceased,
      // Death facts + genetic discriminator (#1407), coerced onto the CHECK sets by
      // the shared normalizers; a model string outside them lands as unstated.
      age_at_death: f.age_at_death ?? null,
      cause_of_death: f.cause_of_death ?? null,
      relation_type: toFamilyRelationType(f.relation_type),
      lineage: toFamilyLineage(f.lineage),
      external_id: null,
    })
  );
  const carePlanItems: PersistCarePlanItem[] = result.carePlanItems.map(
    (c) => ({
      description: c.description,
      code: c.code,
      code_system: c.code_system,
      category: c.category,
      planned_date: c.planned_date,
      status: c.status,
      provider: null,
      external_id: null,
    })
  );
  const careGoals: PersistCareGoal[] = result.careGoals.map((g) => ({
    description: g.description,
    code: g.code,
    code_system: g.code_system,
    target_date: g.target_date,
    status: g.status,
    external_id: null,
  }));
  // Genomic variants (#709). Normalize the model's raw result_type / significance /
  // zygosity onto the DB CHECK sets here (one shared coercion, lib/genomic-variant),
  // so an off-vocabulary term can't fail the INSERT. Optional on the done union, so
  // the `?? []` fallback covers fixtures that predate this field.
  const genomicVariants: PersistGenomicVariant[] = (
    result.genomicVariants ?? []
  )
    // The gene is the required identity anchor (NOT NULL). A gene-less variant
    // can't be stored, so it's dropped here — belt-and-suspenders alongside the
    // normalize-stage drop, since a raw done-result can carry an empty gene.
    .filter((v) => v.gene?.trim())
    .map((v) => ({
      gene: v.gene,
      variant: v.variant,
      genotype: v.genotype,
      star_allele: v.star_allele,
      zygosity: normalizeZygosity(v.zygosity),
      significance: normalizeSignificance(v.significance),
      result_type: normalizeResultType(v.result_type),
      interpretation: v.interpretation,
      source_lab: v.source_lab,
      report_date: v.report_date,
      external_id: null,
    }));
  // Imaging studies (#702). Normalize the model's raw modality / laterality onto the
  // DB CHECK sets and coerce `contrast` to a boolean here (one shared coercion,
  // lib/imaging-study), so an off-vocabulary term can't fail the INSERT. Optional on
  // the done union, so the `?? []` fallback covers fixtures that predate this field.
  const imagingStudies: PersistImagingStudy[] = (result.imagingStudies ?? [])
    // A study with no modality, no region, AND no impression is noise and can't be
    // stored meaningfully — drop it here (belt-and-suspenders alongside the
    // normalize-stage drop, since a raw done-result can carry an empty study).
    .filter(
      (s) => s.modality?.trim() || s.body_region?.trim() || s.impression?.trim()
    )
    .map((s) => ({
      modality: normalizeModality(s.modality),
      body_region: s.body_region,
      laterality: normalizeLaterality(s.laterality),
      contrast: normalizeContrast(s.contrast),
      contrast_agent: s.contrast_agent,
      study_date: s.study_date,
      dose_msv: parseDoseMsv(s.dose_msv),
      impression: s.impression,
      indication: s.indication,
      status: s.status,
      external_id: null,
    }));

  // Optical prescriptions (#697). Normalize the model's raw kind onto the enum and
  // parse the per-eye powers / axis / distances off the Rx notation here (one shared
  // coercion, lib/optical-prescription), so an off-vocabulary term can't fail the
  // INSERT. The prescriber name is wrapped into an ImportedProvider resolved on
  // persist. Optional on the done union, so `?? []` covers predating fixtures.
  const opticalPrescriptions: PersistOpticalPrescription[] = (
    result.opticalPrescriptions ?? []
  )
    // A prescription with no kind signal AND no sphere on either eye is noise (a
    // belt-and-suspenders drop alongside the normalize-stage one).
    .filter((p) => p.kind?.trim() || p.od_sphere?.trim() || p.os_sphere?.trim())
    .map((p) => {
      // Per-eye triples run through the ONE shared coercion (#1036): parse off the
      // Rx notation AND canonicalize a plus-cylinder slip onto minus-cylinder form,
      // exactly as the manual form and the FHIR mapper do.
      const od = parseEyeRefraction(p.od_sphere, p.od_cylinder, p.od_axis);
      const os = parseEyeRefraction(p.os_sphere, p.os_cylinder, p.os_axis);
      return {
        kind: normalizeOpticalKind(p.kind),
        od_sphere: od.sphere,
        od_cylinder: od.cylinder,
        od_axis: od.axis,
        od_add: parseDiopter(p.od_add),
        os_sphere: os.sphere,
        os_cylinder: os.cylinder,
        os_axis: os.axis,
        os_add: parseDiopter(p.os_add),
        pd: parseMillimeters(p.pd),
        base_curve: parseMillimeters(p.base_curve),
        diameter: parseMillimeters(p.diameter),
        brand: p.brand,
        issued_date: p.issued_date,
        expiry_date: p.expiry_date,
        provider: providerFromName(p.prescriber, "individual"),
        notes: p.notes,
        external_id: null,
      };
    });

  // Dental procedures (#705). Normalize the model's raw status / tooth-system onto the
  // DB CHECK sets (one shared coercion, lib/dental), so an off-vocabulary term can't
  // fail the INSERT. A record with no name is noise — drop it.
  const dentalProcedures: PersistDentalProcedure[] = (
    result.dentalProcedures ?? []
  )
    .filter((d) => d.name?.trim())
    .map((d) => ({
      name: d.name!.trim(),
      status: normalizeDentalStatus(d.status),
      tooth: normalizeTooth(d.tooth),
      tooth_system: normalizeToothSystem(d.tooth_system),
      surface: normalizeSurface(d.surface),
      cdt_code: d.cdt_code?.trim() || null,
      procedure_date: d.procedure_date,
      finding: d.finding,
      follow_up_interval_days:
        typeof d.follow_up_interval_days === "number" &&
        Number.isFinite(d.follow_up_interval_days) &&
        d.follow_up_interval_days > 0
          ? Math.floor(d.follow_up_interval_days)
          : null,
      external_id: null,
    }));

  // The document-level source ("Quest Diagnostics", the discharge hospital, …) is
  // registered into the shared providers registry — the AI path's answer to item 3
  // (surface meta.source). Per-row performers (encounter attending / facility) ride
  // on their rows and are unioned by the persist resolver.
  const providers: ImportedProvider[] = [];
  const sourceProvider = providerFromName(result.meta.source, "organization");
  if (sourceProvider) providers.push(sourceProvider);

  // A real import report so the AI path stops being the only one without drop
  // accounting (item 4). No section/resource coverage on the AI path (there are no
  // sections), but every rejected clinical entity is reported as a row-level drop.
  // Kept rows off the ONE shared registry (#1827) — the same one the CCD and FHIR
  // parsers count through. persistDocumentImport rebinds these to the post-persist
  // footprint tally, so this path's card agrees with its extracted count too.
  // Every row-level drop this path reports: the model-shape rejections the
  // normalizer collected, plus the duration door's refusals above (#2322).
  const allDrops: ImportDrop[] = [...result.drops, ...durationDrops];
  const imported = keptRowCount({
    records,
    immunizations,
    allergies,
    conditions,
    encounters,
    procedures,
    familyHistory,
    carePlanItems,
    careGoals,
    genomicVariants,
    imagingStudies,
    opticalPrescriptions,
    dentalProcedures,
    bodyMetrics,
    heights,
    headCircs,
    waistCircs,
  });
  // Lab readings whose canonical NAME matched no curated entry import under that raw
  // name with no reference band and never flag — the AI path's silent analogue of an
  // unmapped LOINC (#918 §4). Surface them so the miss is self-reporting. Labs only:
  // vitals / scans / anthropometrics are intentionally not curated as biomarkers (§5).
  const unresolvedNames = tallyUnresolvedNames(
    records
      .filter((r) => r.category === "lab" && !isSeededCanonical(r.canonical))
      .map((r) => ({ name: r.canonical, unit: r.unit }))
  );
  // Fold the source-text reconciliation (set by the live PDF extract path) into a
  // debugger-facing summary: the confirmed count plus the rows the source did NOT
  // corroborate. Null when the source wasn't a reconcilable PDF.
  const rec = result.reconciliation;
  const reconciliation: ReconciliationSummary | null = rec
    ? {
        confirmed: rec.confirmed,
        total: rec.total,
        flags: rec.items
          .filter(
            (
              i
            ): i is typeof i & {
              verdict: ReconciliationSummary["flags"][number]["verdict"];
            } => i.verdict !== "confirmed"
          )
          .map((i) => ({ name: i.name, value: i.value, verdict: i.verdict })),
      }
    : null;
  const report: ImportReport = {
    drops: allDrops,
    coverage: [],
    imported,
    considered: imported + allDrops.filter(isRowDrop).length,
    unmappedLoincs: [],
    unresolvedNames,
    reconciliation,
    // Per-record confidence (#1601): the model's own certainty per row, summarized
    // and ranked lowest-first for the review surfaces. Null when NO row carried one
    // (a replay of a pre-#1601 stored extraction), so "the model was sure" stays
    // distinguishable from "nobody asked".
    confidence: summarizeExtractionConfidence(
      extractionConfidenceItems(result)
    ),
  };

  return {
    records,
    immunizations,
    allergies,
    conditions,
    encounters,
    procedures,
    familyHistory,
    carePlanItems,
    careGoals,
    genomicVariants,
    imagingStudies,
    opticalPrescriptions,
    dentalProcedures,
    // The AI medical extractor has no appointment shape (it emits care plans, not
    // scheduled visits), so the AI path never produces appointments (#416).
    appointments: [],
    bodyMetrics,
    heights,
    headCircs,
    waistCircs,
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
      importReport: serializeImportReport(report),
    },
    // Register only the names that stay as records (body metrics aren't
    // biomarkers, so they don't enter the vocabulary), and only from the
    // categories that carry a biomarker identity at all (#2318) — an `assessment`
    // row names a questionnaire item or a qualifier, never an analyte.
    canonicalNamesToRegister: records
      .filter((r) => carriesBiomarkerIdentity(r.category))
      .map((r) => r.canonical),
    providers,
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
    // The absolute moment the document stated (#2243), when it stated one with a zone.
    occurred_at: r.occurred_at ?? null,
    // The source lab's own range + interpretation (#761 follow-up), when the CCD
    // stated them; reconcileFlags then refines a mapped lab's flag against the
    // canonical band and leaves an unmapped lab's source flag intact.
    reference_range: r.reference_range ?? null,
    flag: r.flag ?? null,
    panel: null,
    // Narrative report records (#708) carry their body text here; every other
    // reading leaves it null.
    notes: r.notes ?? null,
    source,
    external_id: r.external_id,
    loinc: r.loinc ?? null,
    provider: r.provider ?? null,
    // FHIR `Observation.status` (#1404) when the bundle stated one; the CCD path
    // leaves it null (C-CDA's observation statusCode is a completion state, not the
    // preliminary/corrected/amended result lifecycle, so mapping it would invent a
    // claim the document never made).
    result_status: r.result_status ?? null,
    // Derived medication courses ride on prescription records.
    courses: r.courses ?? null,
    // Structured attribution rides on prescription records (#417).
    prescriber: r.prescriber ?? null,
    pharmacy: r.pharmacy ?? null,
    rxNumber: r.rxNumber ?? null,
    // Tier-1 visit link (#1050): the resolved encounter reference rides through.
    encounter_external_id: r.encounter_external_id ?? null,
    // Tier-1 indication link (#1052): the resolved reason (condition) reference.
    indication_condition_external_id:
      r.indication_condition_external_id ?? null,
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
  // Project waist-circumference records into metric_samples (#2322). LOINC (8280-0 /
  // 56086-2 / 56115-9) is threaded from the CCD mappers, so a waist reading routes
  // correctly even under a generic display name; the waist/hip RATIO code 60803-4 is
  // an explicit negative and is never projected as a length.
  const waistCircs = waistCircsFromReadings(
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
  const records = withoutCapturedWaistCircs(
    withoutCapturedHeadCircs(
      withoutCapturedHeights(
        withoutCapturedBodyMetrics(allRecords, bodyMetrics),
        heights
      ),
      headCircs
    ),
    waistCircs
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
      encounter_external_id: im.encounter_external_id ?? null,
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
      encounter_external_id: a.encounter_external_id ?? null,
    })),
    conditions: (parsed.conditions ?? []).map((c) => ({
      name: c.name,
      code: c.code,
      code_system: c.code_system,
      status: c.status,
      // Already coerced by the deterministic parsers (#1403) — carried, not re-read.
      laterality: c.laterality ?? null,
      severity: c.severity ?? null,
      stage: c.stage ?? null,
      onset_date: c.onset_date,
      resolved_date: c.resolved_date,
      external_id: c.external_id,
      encounter_external_id: c.encounter_external_id ?? null,
    })),
    encounters: (parsed.encounters ?? []).map((e) => ({
      date: e.date,
      end_date: e.end_date,
      type: e.type,
      code: e.code,
      code_system: e.code_system,
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
      encounter_external_id: p.encounter_external_id ?? null,
    })),
    familyHistory: (parsed.familyHistory ?? []).map((f) => ({
      relation: f.relation,
      condition: f.condition,
      code: f.code,
      code_system: f.code_system,
      onset_age: f.onset_age,
      deceased: f.deceased,
      // Already coerced by the deterministic parsers (#1407) — carried, not re-read.
      age_at_death: f.age_at_death ?? null,
      cause_of_death: f.cause_of_death ?? null,
      relation_type: f.relation_type ?? null,
      lineage: f.lineage ?? null,
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
    appointments: (parsed.appointments ?? []).map((a) => ({
      scheduled_at: a.scheduled_at,
      status: a.status,
      title: a.title,
      location: a.location,
      notes: a.notes,
      kind: a.kind,
      provider: a.provider,
      external_id: a.external_id,
    })),
    // Structured imaging studies from a FHIR ImagingStudy / imaging DiagnosticReport /
    // imaging DocumentReference (#708). Already normalized onto the imaging CHECK sets
    // by the FHIR mapper (lib/imaging-study.ts), so this maps straight through —
    // unlike the AI path, which normalizes here.
    imagingStudies: (parsed.imagingStudies ?? []).map((s) => ({
      modality: s.modality,
      body_region: s.body_region,
      laterality: s.laterality,
      contrast: s.contrast,
      contrast_agent: s.contrast_agent,
      study_date: s.study_date,
      // FHIR ImagingStudy carries no simple effective-dose field (dose is a Procedure
      // extension the mapper doesn't parse), so this stays null on the deterministic
      // path — the typical estimate fills in downstream (#703).
      dose_msv: s.dose_msv ?? null,
      impression: s.impression,
      indication: s.indication,
      status: s.status,
      external_id: s.external_id,
    })),
    // Structured optical prescriptions from a FHIR VisionPrescription (#708 → #697).
    // Already normalized onto the OpticalKind enum and parsed to numbers by the FHIR
    // mapper (the shared optical-prescription coercion, #221), so this maps straight
    // through — unlike the AI path, which normalizes here. The prescriber rides as an
    // ImportedProvider resolved into the shared registry on persist.
    opticalPrescriptions: (parsed.opticalPrescriptions ?? []).map((p) => ({
      kind: p.kind,
      od_sphere: p.od_sphere,
      od_cylinder: p.od_cylinder,
      od_axis: p.od_axis,
      od_add: p.od_add,
      os_sphere: p.os_sphere,
      os_cylinder: p.os_cylinder,
      os_axis: p.os_axis,
      os_add: p.os_add,
      pd: p.pd,
      base_curve: p.base_curve,
      diameter: p.diameter,
      brand: p.brand,
      issued_date: p.issued_date,
      expiry_date: p.expiry_date,
      provider: p.provider,
      notes: p.notes,
      external_id: p.external_id,
    })),
    bodyMetrics,
    heights,
    headCircs,
    waistCircs,
    demographics: parsed.demographics
      ? {
          patient_sex: parsed.demographics.sex,
          patient_birthdate: parsed.demographics.birthdate,
          patient_age: null,
          patient_name: parsed.demographics.name,
          patient_postal_code: parsed.demographics.postalCode ?? null,
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
    // `lab` only — a vital has its own home, and a `report` / `assessment` row
    // carries no analyte identity at all (#708/#2318), so this filter is already the
    // strictest form of the NON_IDENTITY_CATEGORIES rule the AI path applies.
    canonicalNamesToRegister: parsed.records
      .filter((r) => r.category === "lab")
      .map((r) => r.canonical),
    // Care-team providers (not tied to one reading) — registered so the family's
    // provider list is populated even before a record is manually linked.
    providers: parsed.providers ?? [],
  };
}
