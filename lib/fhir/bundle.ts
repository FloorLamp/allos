import { isUnmappedLabLoinc } from "../biomarker-loinc";
import { isNoKnownAllergyText } from "../clinical-parse";
import { codeFromVaccineCode } from "../cvx-map";
import type {
  ImportDemographics,
  ImportResult,
  ImportedAllergy,
  ImportedCareGoal,
  ImportedCarePlanItem,
  ImportedCondition,
  ImportedEncounter,
  ImportedFamilyHistory,
  ImportedImmunization,
  ImportedProcedure,
  ImportedRecord,
} from "../health-import";
import type {
  CoverageEntry,
  DropKind,
  DropReason,
  ImportDrop,
  ImportReport,
} from "../import-report";
import { tallyUnmappedLoincs } from "../import-report";
import {
  FhirError,
  ICD10,
  buildResolver,
  conceptName,
  isoDate,
  pickCoding,
} from "./common";
import type { FhirBundleCtx, FhirEntry } from "./common";
import {
  NKA_CODES,
  isEnteredInError,
  mapAllergyResource,
  mapCarePlanResource,
  mapConditionResource,
  mapEncounterResource,
  mapFamilyMemberHistoryResource,
  mapGoalResource,
  mapImmunizationResource,
  mapMedicationResource,
  mapPatientDemographics,
  mapProcedureResource,
  observationRecords,
  recordsFromDiagnosticReport,
} from "./resources";

interface MapperOutput {
  immunization?: ImportedImmunization | null;
  record?: ImportedRecord | null;
  records?: ImportedRecord[];
  allergy?: ImportedAllergy | null;
  condition?: ImportedCondition | null;
  encounter?: ImportedEncounter | null;
  procedure?: ImportedProcedure | null;
  // FamilyMemberHistory yields one row PER condition — a container shape (like
  // DiagnosticReport's records) whose empty array is not itself a dropped row.
  familyHistory?: ImportedFamilyHistory[];
  // CarePlan yields one row PER planned activity (container shape); Goal yields one.
  carePlanItems?: ImportedCarePlanItem[];
  careGoal?: ImportedCareGoal | null;
}

// FHIR resourceType → mapper. Each maps into a provider-neutral ImportedX shape and
// nothing else changes; DocumentReference is deliberately not here (see
// entriesToImportResult note).
const RESOURCE_MAPPERS: Record<
  string,
  (r: any, ctx: FhirBundleCtx) => MapperOutput
> = {
  Immunization: (r, ctx) => ({
    immunization: mapImmunizationResource(r, ctx.idPrefix, ctx),
  }),
  Observation: (r, ctx) => {
    // Zero readings → an explicit null primary shape so the drop path classifies it
    // (no_value / undated). One-or-more (scalar, or a BP's component readings) →
    // the container `records` path, which pushRec-dedups each.
    const recs = observationRecords(r, ctx.idPrefix, ctx);
    return recs.length > 0 ? { records: recs } : { record: null };
  },
  Condition: (r) => ({ condition: mapConditionResource(r) }),
  AllergyIntolerance: (r) => ({ allergy: mapAllergyResource(r) }),
  MedicationRequest: (r, ctx) => ({ record: mapMedicationResource(r, ctx) }),
  MedicationStatement: (r, ctx) => ({ record: mapMedicationResource(r, ctx) }),
  Encounter: (r, ctx) => ({ encounter: mapEncounterResource(r, ctx) }),
  Procedure: (r, ctx) => ({ procedure: mapProcedureResource(r, ctx) }),
  FamilyMemberHistory: (r) => ({
    familyHistory: mapFamilyMemberHistoryResource(r),
  }),
  CarePlan: (r) => ({ carePlanItems: mapCarePlanResource(r) }),
  Goal: (r) => ({ careGoal: mapGoalResource(r) }),
  DiagnosticReport: (r, ctx) => ({
    records: recordsFromDiagnosticReport(r, ctx.idPrefix, ctx),
  }),
};

// The FHIR resourceTypes this importer consumes via a top-level mapper, PLUS the
// Patient it reads for demographics. Bound in a DB-tier test (issue #465) against the
// exporter's emitted set so the two directions can't silently drift — every clinical
// domain the app can import from a bundle it must also be able to export. The two
// read-only equivalents (MedicationStatement aliases MedicationRequest;
// DiagnosticReport is an Observation container) are exported as their canonical form.
export const FHIR_IMPORT_RESOURCE_TYPES = [
  "Patient",
  ...Object.keys(RESOURCE_MAPPERS),
] as const;

// Reduce a flat list of FHIR resources to our ImportResult, deduped by
// external_id; the first Patient supplies demographics. Kept for the SMART Health
// Card decoder (which flattens every card's bundle with no fullUrl); references
// still resolve by `resourceType/id` / bare id.
export function resourcesToImportResult(
  resources: any[],
  idPrefix: string
): ImportResult {
  return entriesToImportResult(
    (Array.isArray(resources) ? resources : [])
      .filter(Boolean)
      .map((resource) => ({ resource })),
    idPrefix
  );
}

// ---- import DEBUGGER: drop-reason + coverage ----
//
// The resource mappers above return null for a retracted (entered-in-error) reading,
// one with no usable date, an unmapped vaccine code, or a "no known allergy" coded
// negation; and whole resource types with no mapper (Procedure, DocumentReference)
// are skipped. This records each drop + why, and which resource types the bundle
// carried vs. which the app mapped — without changing what imports. Classification
// reads the raw resource, so the mappers stay untouched.

// The DropKind for a dropped resource, by its FHIR resourceType.
function fhirDropKind(resourceType: string): DropKind {
  switch (resourceType) {
    case "Immunization":
      return "immunization";
    case "Observation":
    case "DiagnosticReport":
      return "lab";
    case "Condition":
      return "condition";
    case "AllergyIntolerance":
      return "allergy";
    case "MedicationRequest":
    case "MedicationStatement":
      return "medication";
    case "Encounter":
      return "encounter";
    case "Procedure":
      return "procedure";
    case "FamilyMemberHistory":
      return "family_history";
    case "CarePlan":
      return "care_plan";
    case "Goal":
      return "care_goal";
    default:
      return "resource";
  }
}

// A human label for a dropped resource — its clinical name / substance / drug, else
// the resource type.
function fhirDropLabel(resourceType: string, r: any): string {
  switch (resourceType) {
    case "Immunization":
      return conceptName(r?.vaccineCode) ?? "Immunization";
    case "Observation":
      return conceptName(r?.code) ?? "Observation";
    case "Condition":
      return conceptName(r?.code) ?? "Condition";
    case "AllergyIntolerance":
      return conceptName(r?.code) ?? "Allergy";
    case "MedicationRequest":
    case "MedicationStatement":
      return (
        conceptName(r?.medicationCodeableConcept ?? r?.medication?.concept) ??
        "Medication"
      );
    case "Encounter":
      return (
        conceptName(Array.isArray(r?.type) ? r.type[0] : r?.type) ?? "Encounter"
      );
    case "Procedure":
      return conceptName(r?.code) ?? "Procedure";
    case "FamilyMemberHistory":
      return conceptName(r?.relationship) ?? "Family history";
    case "CarePlan":
      return (
        (typeof r?.title === "string" && r.title.trim()
          ? r.title.trim()
          : null) ??
        conceptName(Array.isArray(r?.category) ? r.category[0] : r?.category) ??
        "Care plan"
      );
    case "Goal":
      return (
        (typeof r?.description?.text === "string" && r.description.text.trim()
          ? r.description.text.trim()
          : null) ?? "Goal"
      );
    default:
      return resourceType;
  }
}

// Why a mapped-to-null resource was dropped. Mirrors each mapper's guard order:
// a retracted/entered-in-error status is `negated`; an unmapped vaccine code is
// `unmapped_loinc`; a missing date is `other`.
function fhirDropReason(resourceType: string, r: any): DropReason {
  const status = r?.status;
  if (status === "entered-in-error" || status === "not-done") return "negated";
  if (isEnteredInError(r)) return "negated";
  if (resourceType === "Observation" && status === "cancelled")
    return "negated";
  if (resourceType === "Immunization") {
    if (!codeFromVaccineCode(r?.vaccineCode)) return "unmapped_loinc";
    if (!isoDate(r?.occurrenceDateTime)) return "other";
  }
  if (resourceType === "Observation") {
    // A dropped Observation with no usable date is `other`; one that HAS a date but
    // yielded no reading carried no productive value (no scalar value AND no valued
    // component) — mirror the CDA path's no_value drop.
    if (
      !isoDate(r?.effectiveDateTime ?? r?.issued ?? r?.effectivePeriod?.start)
    )
      return "other";
    return "no_value";
  }
  if (resourceType === "AllergyIntolerance") {
    const { code } = pickCoding(r?.code, [ICD10]);
    const substance = conceptName(r?.code);
    if (
      (code && NKA_CODES.has(code)) ||
      (substance && isNoKnownAllergyText(substance))
    )
      return "negated";
    if (!substance) return "no_value";
  }
  if (resourceType === "Condition" && !conceptName(r?.code)) return "no_value";
  if (resourceType === "Procedure" && !conceptName(r?.code)) return "no_value";
  if (
    resourceType === "FamilyMemberHistory" &&
    !(Array.isArray(r?.condition) ? r.condition : []).some((c: any) =>
      conceptName(c?.code)
    )
  )
    return "no_value";
  if (resourceType === "Goal" && !conceptName(r?.description))
    return "no_value";
  if (
    resourceType === "CarePlan" &&
    (Array.isArray(r?.activity) ? r.activity : []).length === 0 &&
    !(typeof r?.title === "string" && r.title.trim())
  )
    return "no_value";
  return "other";
}

// Resource types consumed BY REFERENCE rather than by a top-level mapper — so they
// carry no entry in RESOURCE_MAPPERS yet are still read. A `Medication` is resolved
// for a MedicationRequest/Statement's drug (mapMedicationResource), and
// `Practitioner` / `Organization` / `PractitionerRole` are routed into the shared
// providers registry as performers / participants / locations (via
// providerFromResource). Real Epic/Apple bundles carry these as top-level entries,
// so without this they'd wrongly read "present but not consumed" (and emit spurious
// unrecognized_section drops). Genuinely-unconsumed support types —
// DocumentReference, Device, Location — are deliberately NOT here and stay
// not-consumed. (Procedure + FamilyMemberHistory now have top-level mappers, so
// they're consumed via RESOURCE_MAPPERS rather than here.)
const REFERENCE_CONSUMED = new Set([
  "Medication",
  "Practitioner",
  "Organization",
  "PractitionerRole",
]);

// A CoverageEntry per resource type present in the bundle: consumed when a top-level
// mapper exists, it's the Patient that supplies demographics, or it's a
// reference-consumed support type (see REFERENCE_CONSUMED).
function fhirCoverage(entries: FhirEntry[]): CoverageEntry[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const rt = e?.resource?.resourceType;
    if (typeof rt === "string" && rt) counts.set(rt, (counts.get(rt) ?? 0) + 1);
  }
  const out: CoverageEntry[] = [];
  for (const [rt, present] of counts) {
    const consumed =
      rt === "Patient" || rt in RESOURCE_MAPPERS || REFERENCE_CONSUMED.has(rt);
    out.push({ key: rt, title: rt, consumed, present });
  }
  return out;
}

// The bundle-aware core: entries carry fullUrl so references resolve. Beyond
// Patient/Observation/Immunization it now maps Condition → ImportedCondition,
// AllergyIntolerance → ImportedAllergy, MedicationRequest/MedicationStatement →
// medication ImportedRecord, Encounter → ImportedEncounter, Procedure →
// ImportedProcedure, FamilyMemberHistory → ImportedFamilyHistory rows, and
// DiagnosticReport → its contained/referenced lab Observations. DocumentReference (a
// pointer to an external document, no structured reading) is intentionally left
// unmapped — forcing it into an existing sink would fabricate mis-categorized rows.
// Provider provenance rides on each shape and is resolved into the shared registry
// by the persist layer.
export function entriesToImportResult(
  entries: FhirEntry[],
  idPrefix: string
): ImportResult {
  const resolve = buildResolver(entries);
  const ctx: FhirBundleCtx = { idPrefix, resolve };

  const immunizations: ImportedImmunization[] = [];
  const records: ImportedRecord[] = [];
  const allergies: ImportedAllergy[] = [];
  const conditions: ImportedCondition[] = [];
  const encounters: ImportedEncounter[] = [];
  const procedures: ImportedProcedure[] = [];
  const familyHistory: ImportedFamilyHistory[] = [];
  const carePlanItems: ImportedCarePlanItem[] = [];
  const careGoals: ImportedCareGoal[] = [];
  let demographics: ImportDemographics | null = null;

  const seenImm = new Set<string>();
  const seenRec = new Set<string>();
  const seenAlg = new Set<string>();
  const seenCond = new Set<string>();
  const seenEnc = new Set<string>();
  const seenProc = new Set<string>();
  const seenFam = new Set<string>();
  const seenCarePlan = new Set<string>();
  const seenCareGoal = new Set<string>();

  // Import DEBUGGER accumulators.
  const drops: ImportDrop[] = [];
  const dropFor = (r: any): ImportDrop => ({
    kind: fhirDropKind(r.resourceType),
    label: fhirDropLabel(r.resourceType, r),
    reason: fhirDropReason(r.resourceType, r),
    section: r.resourceType,
  });
  // Record a `deduped` drop when a mapped reading's key was already imported.
  const pushRec = (rec: ImportedRecord | null | undefined, r?: any) => {
    if (!rec) return;
    if (seenRec.has(rec.external_id)) {
      if (r)
        drops.push({
          kind: fhirDropKind(r.resourceType),
          label: rec.name,
          reason: "deduped",
          section: r.resourceType,
        });
      return;
    }
    seenRec.add(rec.external_id);
    records.push(rec);
  };

  for (const e of entries) {
    const r = e?.resource;
    if (!r) continue;
    if (r.resourceType === "Patient" && !demographics) {
      demographics = mapPatientDemographics(r);
    }
    const mapper = RESOURCE_MAPPERS[r.resourceType];
    if (!mapper) continue;
    const out = mapper(r, ctx);
    // A DiagnosticReport is a container (out.records) — never itself a dropped row;
    // its readings are recorded via pushRec. Every other mapper yields one primary
    // shape whose explicit null means "dropped" — classify it.
    const isContainer = out.records !== undefined;
    if (out.immunization) {
      if (seenImm.has(out.immunization.external_id))
        drops.push({
          kind: "immunization",
          label: out.immunization.code,
          reason: "deduped",
          section: r.resourceType,
        });
      else {
        seenImm.add(out.immunization.external_id);
        immunizations.push(out.immunization);
      }
    } else if (out.immunization === null) drops.push(dropFor(r));
    pushRec(out.record, r);
    if (out.record === null && !isContainer) drops.push(dropFor(r));
    if (out.records) for (const rec of out.records) pushRec(rec, r);
    if (out.allergy) {
      if (seenAlg.has(out.allergy.external_id))
        drops.push({
          kind: "allergy",
          label: out.allergy.substance,
          reason: "deduped",
          section: r.resourceType,
        });
      else {
        seenAlg.add(out.allergy.external_id);
        allergies.push(out.allergy);
      }
    } else if (out.allergy === null) drops.push(dropFor(r));
    if (out.condition) {
      if (seenCond.has(out.condition.external_id))
        drops.push({
          kind: "condition",
          label: out.condition.name,
          reason: "deduped",
          section: r.resourceType,
        });
      else {
        seenCond.add(out.condition.external_id);
        conditions.push(out.condition);
      }
    } else if (out.condition === null) drops.push(dropFor(r));
    if (out.encounter) {
      if (seenEnc.has(out.encounter.external_id))
        drops.push({
          kind: "encounter",
          label: out.encounter.type ?? out.encounter.date,
          reason: "deduped",
          section: r.resourceType,
        });
      else {
        seenEnc.add(out.encounter.external_id);
        encounters.push(out.encounter);
      }
    } else if (out.encounter === null) drops.push(dropFor(r));
    if (out.procedure) {
      if (seenProc.has(out.procedure.external_id))
        drops.push({
          kind: "procedure",
          label: out.procedure.name,
          reason: "deduped",
          section: r.resourceType,
        });
      else {
        seenProc.add(out.procedure.external_id);
        procedures.push(out.procedure);
      }
    } else if (out.procedure === null) drops.push(dropFor(r));
    // FamilyMemberHistory is a container (out.familyHistory) — one row per condition;
    // an empty array means the resource carried no usable condition → a dropped row.
    if (out.familyHistory !== undefined) {
      if (out.familyHistory.length === 0) drops.push(dropFor(r));
      for (const fh of out.familyHistory) {
        if (seenFam.has(fh.external_id))
          drops.push({
            kind: "family_history",
            label: `${fh.relation ?? "Relative"}: ${fh.condition}`,
            reason: "deduped",
            section: r.resourceType,
          });
        else {
          seenFam.add(fh.external_id);
          familyHistory.push(fh);
        }
      }
    }
    // CarePlan is a container (out.carePlanItems) — one row per planned activity;
    // an empty array means the plan carried no usable activity → a dropped row.
    if (out.carePlanItems !== undefined) {
      if (out.carePlanItems.length === 0) drops.push(dropFor(r));
      for (const cp of out.carePlanItems) {
        if (seenCarePlan.has(cp.external_id))
          drops.push({
            kind: "care_plan",
            label: cp.description,
            reason: "deduped",
            section: r.resourceType,
          });
        else {
          seenCarePlan.add(cp.external_id);
          carePlanItems.push(cp);
        }
      }
    }
    if (out.careGoal) {
      if (seenCareGoal.has(out.careGoal.external_id))
        drops.push({
          kind: "care_goal",
          label: out.careGoal.description,
          reason: "deduped",
          section: r.resourceType,
        });
      else {
        seenCareGoal.add(out.careGoal.external_id);
        careGoals.push(out.careGoal);
      }
    } else if (out.careGoal === null) drops.push(dropFor(r));
  }

  // Resource types the bundle carried but no mapper consumed (DocumentReference, …)
  // — surfaced in coverage AND as an unrecognized-section drop.
  const coverage = fhirCoverage(entries);
  for (const c of coverage) {
    if (!c.consumed)
      drops.push({
        kind: "resource",
        label: c.title,
        reason: "unrecognized_section",
        section: c.title,
      });
  }

  immunizations.sort((a, b) => a.date.localeCompare(b.date));
  records.sort((a, b) => a.date.localeCompare(b.date));
  allergies.sort((a, b) => a.substance.localeCompare(b.substance));
  conditions.sort((a, b) => a.name.localeCompare(b.name));
  encounters.sort((a, b) => b.date.localeCompare(a.date));
  procedures.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  familyHistory.sort((a, b) => a.condition.localeCompare(b.condition));
  carePlanItems.sort((a, b) =>
    (a.planned_date ?? "").localeCompare(b.planned_date ?? "")
  );
  careGoals.sort((a, b) =>
    (a.target_date ?? "").localeCompare(b.target_date ?? "")
  );

  const imported =
    records.length +
    immunizations.length +
    allergies.length +
    conditions.length +
    encounters.length +
    procedures.length +
    familyHistory.length +
    carePlanItems.length +
    careGoals.length;
  const rowDrops = drops.filter(
    (d) => d.reason !== "unrecognized_section"
  ).length;
  // Labs that imported but carry a LOINC with no canonical mapping (Fix 3): a
  // non-fatal "add these to LOINC_TO_CANONICAL" annotation surfaced in the debugger.
  const unmappedLoincs = tallyUnmappedLoincs(
    records
      .filter((rec) => isUnmappedLabLoinc(rec.loinc))
      // unit is catalog identity (it rides into the "Report unmapped code"
      // prefill) — never the measured value itself.
      .map((rec) => ({ loinc: rec.loinc, name: rec.name, unit: rec.unit }))
  );
  const report: ImportReport = {
    drops,
    coverage,
    imported,
    considered: imported + rowDrops,
    unmappedLoincs,
  };

  return {
    immunizations,
    records,
    allergies,
    conditions,
    encounters,
    procedures,
    familyHistory,
    carePlanItems,
    careGoals,
    demographics,
    report,
  };
}

// Parse a raw FHIR R4 Bundle (JSON text) — an Epic SMART-on-FHIR export or an
// Apple Health "Export FHIR" — into our ImportResult. Unsigned; provenance is
// tagged "fhir". Entry fullUrls are preserved so intra-bundle references resolve.
export function parseFhirBundle(text: string): ImportResult {
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new FhirError("Invalid FHIR bundle (could not parse JSON).");
  }
  if (!obj || obj.resourceType !== "Bundle") {
    throw new FhirError("Not a FHIR Bundle.");
  }
  const entries: FhirEntry[] = (Array.isArray(obj.entry) ? obj.entry : [])
    .filter((e: any) => e?.resource)
    .map((e: any) => ({
      fullUrl: typeof e.fullUrl === "string" ? e.fullUrl : undefined,
      resource: e.resource,
    }));
  return entriesToImportResult(entries, "fhir");
}
