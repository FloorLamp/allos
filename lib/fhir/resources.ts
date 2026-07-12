import {
  allergyExternalId,
  careGoalExternalId,
  carePlanExternalId,
  conditionExternalId,
  familyHistoryExternalId,
  isNoKnownAllergyText,
  medicationExternalId,
  procedureExternalId,
  toAllergyStatus,
  toConditionStatus,
} from "../clinical-parse";
import type { FhirCodeableConcept } from "../cvx-map";
import { codeFromVaccineCode } from "../cvx-map";
import type {
  ImportDemographics,
  ImportedAllergy,
  ImportedAppointment,
  ImportedCareGoal,
  ImportedCarePlanItem,
  ImportedCondition,
  ImportedEncounter,
  ImportedFamilyHistory,
  ImportedImmunization,
  ImportedProcedure,
  ImportedRecord,
} from "../health-import";
import type { AppointmentKind, AppointmentStatus } from "../types";
import type { ImportMedPeriod } from "../medication-course-import";
import {
  coursesFromImportedMedication,
  normalizeFhirMedStatus,
} from "../medication-course-import";
import {
  ICD10,
  RXNORM,
  conceptName,
  doseLabel,
  fhirReadingFromCode,
  firstCodingCode,
  humanName,
  isoDate,
  pickCoding,
  providerFromRefs,
  readFhirObservationValue,
} from "./common";
import type { FhirBundleCtx } from "./common";

export function mapImmunizationResource(
  r: any,
  idPrefix: string,
  ctx?: FhirBundleCtx
): ImportedImmunization | null {
  if (r.status === "entered-in-error" || r.status === "not-done") return null;
  const code = codeFromVaccineCode(r.vaccineCode);
  const date = isoDate(r.occurrenceDateTime);
  if (!code || !date) return null;
  const lot = typeof r.lotNumber === "string" ? r.lotNumber.trim() : "";
  // The administering clinic/clinician (Immunization.performer[].actor) — kept as
  // provenance, preferring the recognizable organization.
  const provider = ctx
    ? providerFromRefs(
        (Array.isArray(r.performer) ? r.performer : []).map(
          (p: any) => p?.actor
        ),
        ctx,
        r.contained,
        "organization"
      )
    : null;
  return {
    code,
    date,
    dose_label: doseLabel(r),
    notes: lot ? `Lot ${lot}` : null,
    external_id: `${idPrefix}:${code}:${date}`,
    provider,
  };
}

// ---- Observation ----

// Map one Observation resource to ZERO or more readings. A scalar Observation is
// one reading; a panel-style Observation that carries its real numbers in
// component[] (canonically, blood pressure LOINC 85354-9 with systolic 8480-6 +
// diastolic 8462-4 components — how Epic/Apple "Export FHIR" ships BP) becomes ONE
// reading per valued component. A valueless, component-less Observation is DROPPED
// (empty array) rather than importing a nameless "—" row.
export function observationRecords(
  r: any,
  idPrefix: string,
  ctx?: FhirBundleCtx
): ImportedRecord[] {
  // Drop retracted/void readings, mirroring the immunization mapper — an
  // entered-in-error or cancelled Observation is not real data.
  if (r?.status === "entered-in-error" || r?.status === "cancelled") return [];
  // Keep the prior `effectiveDateTime ?? issued` order so no already-stored key
  // shifts; effectivePeriod.start is only a final fallback that RECOVERS
  // observations which carry a period but neither of those (previously dropped).
  const date = isoDate(
    r?.effectiveDateTime ?? r?.issued ?? r?.effectivePeriod?.start
  );
  if (!date) return [];
  // The performing lab/org (Observation.performer) — provenance.
  const provider = ctx
    ? providerFromRefs(r?.performer, ctx, r?.contained, "organization")
    : null;

  const out: ImportedRecord[] = [];
  // A component-bearing Observation carries its numbers in the components (BP), so
  // emit one reading per valued component. A rare top-level value alongside
  // components is also kept so nothing is lost.
  const components = Array.isArray(r?.component) ? r.component : [];
  for (const comp of components) {
    const val = readFhirObservationValue(comp);
    if (!val) continue;
    out.push(fhirReadingFromCode(comp?.code, val, date, idPrefix, provider));
  }
  const topVal = readFhirObservationValue(r);
  if (topVal) {
    out.push(
      fhirReadingFromCode(
        r?.code as FhirCodeableConcept | undefined,
        topVal,
        date,
        idPrefix,
        provider
      )
    );
  }
  return out;
}

// Back-compat single-reading accessor: the FIRST reading an Observation yields, or
// null when it yields none (valueless / retracted / undated). Callers that need the
// full set (BP components) use observationRecords.
export function mapObservationResource(
  r: any,
  idPrefix: string,
  ctx?: FhirBundleCtx
): ImportedRecord | null {
  return observationRecords(r, idPrefix, ctx)[0] ?? null;
}

// ---- Condition ----

// entered-in-error verificationStatus → the assertion is retracted, skip.
export function isEnteredInError(res: any): boolean {
  return firstCodingCode(res?.verificationStatus) === "entered-in-error";
}

export function mapConditionResource(r: any): ImportedCondition | null {
  if (isEnteredInError(r)) return null;
  const name = conceptName(r?.code);
  if (!name) return null;
  // Mirror the CDA pickCode preference (billing ICD-10 first, else the primary /
  // first coding) so the `ccda:condition:` key matches across formats.
  const { code, system } = pickCoding(r?.code, [ICD10]);
  const status = toConditionStatus(
    firstCodingCode(r?.clinicalStatus) ?? conceptName(r?.clinicalStatus)
  );
  const onset = isoDate(r?.onsetDateTime ?? r?.onsetPeriod?.start);
  const resolved =
    status === "resolved"
      ? isoDate(r?.abatementDateTime ?? r?.abatementPeriod?.end)
      : null;
  return {
    name,
    code,
    code_system: system,
    status,
    onset_date: onset,
    resolved_date: resolved,
    external_id: conditionExternalId({ name, code, onsetDate: onset }),
  };
}

// ---- AllergyIntolerance ----

// SNOMED codes that assert the ABSENCE of an allergy ("No known allergy", "No known
// drug allergy", …) — a coded negation the CDA path also honors. Such a resource is
// dropped rather than becoming a junk allergy row.
export const NKA_CODES = new Set([
  "716186003",
  "409137002",
  "428607008",
  "429625007",
  "410942007",
  "105590001",
]);

function allergyReactionText(r: any): string | null {
  for (const rx of Array.isArray(r?.reaction) ? r.reaction : []) {
    for (const m of Array.isArray(rx?.manifestation) ? rx.manifestation : []) {
      const n = conceptName(m);
      if (n) return n;
    }
    if (typeof rx?.description === "string" && rx.description.trim())
      return rx.description.trim();
  }
  return null;
}

function allergySeverityText(r: any): string | null {
  for (const rx of Array.isArray(r?.reaction) ? r.reaction : []) {
    if (typeof rx?.severity === "string" && rx.severity.trim())
      return rx.severity.trim();
  }
  if (typeof r?.criticality === "string" && r.criticality.trim())
    return r.criticality.trim();
  return null;
}

export function mapAllergyResource(r: any): ImportedAllergy | null {
  if (isEnteredInError(r)) return null;
  const substance = conceptName(r?.code);
  // Match the CDA pickCode preference exactly (ICD-10 first, else the primary /
  // first coding) so the same substance yields the SAME `ccda:allergy:` key
  // whichever format carried it — a CDA allergy with a SNOMED own-code + RxNorm
  // translation must not diverge from the FHIR allergy for the same substance.
  const { code, system } = pickCoding(r?.code, [ICD10]);
  // "No known allergies" is carried as a coded/text negation — emit nothing.
  if (
    (code && NKA_CODES.has(code)) ||
    (substance && isNoKnownAllergyText(substance))
  )
    return null;
  if (!substance) return null;
  const status = toAllergyStatus(
    firstCodingCode(r?.clinicalStatus) ?? conceptName(r?.clinicalStatus)
  );
  const onset = isoDate(r?.onsetDateTime ?? r?.onsetPeriod?.start);
  return {
    substance,
    substance_code: code,
    substance_code_system: system,
    reaction: allergyReactionText(r),
    severity: allergySeverityText(r),
    status,
    onset_date: onset,
    external_id: allergyExternalId({
      substance,
      substanceCode: code,
      onsetDate: onset,
    }),
  };
}

// ---- MedicationRequest / MedicationStatement ----

// The dosage/instruction free text (MedicationRequest.dosageInstruction[].text or
// MedicationStatement.dosage[].text), stored as the record's value like the CDA
// dose string.
function dosageText(r: any): string | null {
  const arr = Array.isArray(r?.dosageInstruction)
    ? r.dosageInstruction
    : Array.isArray(r?.dosage)
      ? r.dosage
      : [];
  for (const d of arr) {
    if (typeof d?.text === "string" && d.text.trim()) return d.text.trim();
  }
  return null;
}

// A medication's effective/therapy period(s), for course derivation:
// the effectivePeriod (start/end), an effectiveDateTime point, and any
// dosage[].timing.repeat.boundsPeriod. The persist layer dedups on started_on, so
// overlapping sources collapse.
function fhirMedPeriods(r: any): ImportMedPeriod[] {
  const out: ImportMedPeriod[] = [];
  const ep = r?.effectivePeriod;
  if (ep && (ep.start || ep.end))
    out.push({ low: isoDate(ep.start), high: isoDate(ep.end) });
  const point = isoDate(r?.effectiveDateTime);
  if (point) out.push({ low: point, high: null });
  const dosageArr = Array.isArray(r?.dosageInstruction)
    ? r.dosageInstruction
    : Array.isArray(r?.dosage)
      ? r.dosage
      : [];
  for (const d of dosageArr) {
    const bp = d?.timing?.repeat?.boundsPeriod;
    if (bp && (bp.start || bp.end))
      out.push({ low: isoDate(bp.start), high: isoDate(bp.end) });
  }
  return out;
}

// A short free-text detail for the derived course: why the med was stopped
// (statusReason) or, failing that, why it was prescribed (reasonCode).
// statusReason is a SINGLE CodeableConcept on MedicationRequest but an
// ARRAY on MedicationStatement, so accept both (first non-empty concept name).
function fhirMedStatusNote(r: any): string | null {
  const statusReasons = Array.isArray(r?.statusReason)
    ? r.statusReason
    : [r?.statusReason];
  for (const sr of statusReasons) {
    const n = conceptName(sr);
    if (n) return n;
  }
  for (const rc of Array.isArray(r?.reasonCode) ? r.reasonCode : []) {
    const n = conceptName(rc);
    if (n) return n;
  }
  return null;
}

// The first non-empty Identifier.value on a resource — used for a prescription's
// Rx number (MedicationRequest.identifier). Accepts an array or a single object.
function firstIdentifierValue(identifier: any): string | null {
  const list = Array.isArray(identifier)
    ? identifier
    : identifier != null
      ? [identifier]
      : [];
  for (const id of list) {
    if (typeof id?.value === "string" && id.value.trim())
      return id.value.trim();
  }
  return null;
}

export function mapMedicationResource(
  r: any,
  ctx: FhirBundleCtx
): ImportedRecord | null {
  if (r?.status === "entered-in-error") return null;
  // The drug: an inline medicationCodeableConcept (R4) / medication.concept (R5),
  // else a medicationReference / medication reference resolved to a Medication.
  let concept = r?.medicationCodeableConcept ?? r?.medication?.concept ?? null;
  if (!concept) {
    const med = ctx.resolve(
      r?.medicationReference ?? r?.medication,
      r?.contained
    );
    // Guard the resolved target's resourceType before trusting its `.code` — the
    // bare-id fallback in buildResolver is now type-checked, but a Medication
    // reference must still resolve to an actual Medication (never an Observation /
    // other resource) so a lab can't be mislabeled a prescription.
    if (med?.resourceType === "Medication") concept = med.code ?? null;
  }
  const name = conceptName(concept);
  const { code } = pickCoding(concept, [RXNORM]);
  const drug = name ?? code;
  if (!drug) return null;
  // Prefer the therapy/effective date over the order-written date so a med that
  // carries an effective time aligns with the CDA path (which keys on
  // effectiveTime) — see the medicationExternalId note on cross-format dedup.
  const date = isoDate(
    r?.effectiveDateTime ??
      r?.effectivePeriod?.start ??
      r?.authoredOn ??
      r?.dateAsserted
  );
  if (!date) return null;
  // Derived courses: effective period(s) → dates, status →
  // open/closed + stop_reason. entered-in-error already returned null above; the
  // pure derivation returns null for it too (belt and suspenders).
  const periods = fhirMedPeriods(r);
  const courses = coursesFromImportedMedication(
    periods.length ? periods : [{ low: date, high: null }],
    normalizeFhirMedStatus(r?.status),
    { note: fhirMedStatusNote(r), fallbackStopDate: date }
  );
  if (courses === null) return null;
  // Structured attribution (#417): the ordering clinician (requester), the
  // dispensing pharmacy (dispenseRequest.performer), and the prescription's Rx
  // number (identifier). providerFromRefs resolves a referenced Practitioner/
  // Organization or a bare display string.
  const prescriber =
    providerFromRefs(r?.requester, ctx, r?.contained, "individual")?.name ??
    null;
  const pharmacy =
    providerFromRefs(
      r?.dispenseRequest?.performer,
      ctx,
      r?.contained,
      "organization"
    )?.name ?? null;
  const rxNumber = firstIdentifierValue(r?.identifier);
  return {
    category: "prescription",
    name: drug,
    canonical: drug,
    value: dosageText(r),
    value_num: null,
    unit: null,
    date,
    external_id: medicationExternalId({ name: drug, code, date }),
    courses,
    prescriber,
    pharmacy,
    rxNumber,
  };
}

// ---- Encounter ----

// The HL7 v3 ActEncounterCode class (AMB / IMP / EMER / …). R4 carries it as a bare
// Coding on `class`; R5 as a CodeableConcept[].
// FHIR Appointment.status → the app's 3-value appointment lifecycle. A booked/
// pending/proposed/arrived/checked-in/waitlist visit is still-scheduled; fulfilled
// is completed; cancelled/noshow are cancelled. entered-in-error has no entry (the
// mapper drops it).
const FHIR_APPOINTMENT_STATUS: Record<string, AppointmentStatus> = {
  proposed: "scheduled",
  pending: "scheduled",
  booked: "scheduled",
  arrived: "scheduled",
  "checked-in": "scheduled",
  waitlist: "scheduled",
  fulfilled: "completed",
  cancelled: "cancelled",
  noshow: "cancelled",
};

// Preserve the appointment's date AND wall-clock time when the FHIR instant carries
// one ("2026-08-01T14:30:00Z" → "2026-08-01T14:30", matching the datetime-local
// format a manual booking stores); a date-only value stays "YYYY-MM-DD". Null when
// the date portion isn't a real calendar date.
function appointmentDateTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const date = isoDate(v);
  if (!date) return null;
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(v.trim());
  return m ? `${date}T${m[1]}` : date;
}

// Best-effort map from an Appointment's SERVICE/TYPE codings to one of the app's
// explicit appointment kinds — a stronger, deliberate signal than title guessing.
// Only an unambiguous keyword sets a kind; anything else stays null (a null kind
// never matches a preventive rule), so an imported visit surfaces on the calendar
// without ever fabricating a preventive-satisfying match.
function appointmentKindFromFhir(r: any): AppointmentKind | null {
  const parts: string[] = [];
  const push = (c: any) => {
    const n = conceptName(c);
    if (n) parts.push(n);
  };
  push(r?.appointmentType);
  for (const s of Array.isArray(r?.serviceType) ? r.serviceType : [])
    push(s?.concept ?? s);
  for (const s of Array.isArray(r?.serviceCategory) ? r.serviceCategory : [])
    push(s);
  const t = parts.join(" ").toLowerCase();
  if (!t) return null;
  if (/\b(dental|dentist|teeth|cleaning|hygien)/.test(t)) return "dental";
  if (/\b(vision|eye|optometr|ophthalm)/.test(t)) return "vision";
  if (/\bwell[\s-]?child|child\s+check|pediatric\s+well/.test(t))
    return "well_child";
  if (/\b(physical|check[\s-]?up|annual\s+exam|wellness\s+visit)/.test(t))
    return "physical";
  if (/\b(screen|mammogram|colonoscop|pap\b)/.test(t)) return "screening";
  return null;
}

// FHIR Appointment → ImportedAppointment (issue #416). No CDA equivalent exists, so
// this is FHIR-only. A dateless (no start) or entered-in-error appointment is dropped
// (null) — the appointments.scheduled_at column is NOT NULL, so an unschedulable row
// can't be placed. The attending clinician is resolved from a Practitioner-referencing
// participant; the facility is a plain location string from a Location participant.
export function mapAppointmentResource(
  r: any,
  ctx: FhirBundleCtx
): ImportedAppointment | null {
  if (r?.status === "entered-in-error") return null;
  const scheduled_at = appointmentDateTime(r?.start);
  if (!scheduled_at) return null;
  const status: AppointmentStatus =
    (typeof r?.status === "string" && FHIR_APPOINTMENT_STATUS[r.status]) ||
    "scheduled";

  const participants = Array.isArray(r?.participant) ? r.participant : [];
  // Attending clinician: participant actors EXCEPT the Location (facility) and
  // Patient references, so a Location/Patient participant isn't mistaken for a
  // provider. The remaining refs (often bare urn:uuid pointers to a Practitioner)
  // are resolved by providerFromRefs, which keeps the individual it finds.
  const clinicianActors = participants
    .map((p: any) => p?.actor)
    .filter((a: any) => {
      const ref = typeof a?.reference === "string" ? a.reference : "";
      return (
        !/(?:^|\/)Location\//i.test(ref) && !/(?:^|\/)Patient\//i.test(ref)
      );
    });
  const provider = providerFromRefs(
    clinicianActors,
    ctx,
    r?.contained,
    "individual"
  );
  // Facility: a Location-referencing participant's display, if any.
  let location: string | null = null;
  for (const p of participants) {
    const a = p?.actor;
    if (
      typeof a?.reference === "string" &&
      /Location\//i.test(a.reference) &&
      typeof a?.display === "string" &&
      a.display.trim()
    ) {
      location = a.display.trim();
      break;
    }
  }

  const title =
    (typeof r?.description === "string" && r.description.trim()
      ? r.description.trim()
      : null) ??
    conceptName(
      Array.isArray(r?.serviceType) ? r.serviceType[0] : r?.serviceType
    ) ??
    conceptName(r?.appointmentType);
  const notes =
    (typeof r?.comment === "string" && r.comment.trim()
      ? r.comment.trim()
      : null) ??
    (typeof r?.patientInstruction === "string" && r.patientInstruction.trim()
      ? r.patientInstruction.trim()
      : null);

  const external_id =
    r?.id != null
      ? `fhir:appointment:${r.id}`
      : `fhir:appointment:${scheduled_at}:${(title ?? "").toLowerCase()}`;

  return {
    scheduled_at,
    status,
    title,
    location,
    notes,
    kind: appointmentKindFromFhir(r),
    provider,
    external_id,
  };
}

function encounterClass(cls: any): string | null {
  if (!cls) return null;
  if (Array.isArray(cls)) {
    for (const c of cls) {
      const code = firstCodingCode(c);
      if (code) return code;
    }
    return null;
  }
  if (typeof cls.code === "string") return cls.code;
  return firstCodingCode(cls);
}

function encounterReason(r: any): string | null {
  for (const c of Array.isArray(r?.reasonCode) ? r.reasonCode : []) {
    const n = conceptName(c);
    if (n) return n;
  }
  return null;
}

// Visit diagnoses: each Encounter.diagnosis[].condition is a Reference to a
// Condition (R4) or a CodeableReference (R5). Resolve the reference to read the
// problem name; fall back to an inline CodeableReference.concept.
function encounterDiagnoses(r: any, ctx: FhirBundleCtx): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string | null) => {
    if (!name) return;
    const k = name.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(name);
    }
  };
  for (const d of Array.isArray(r?.diagnosis) ? r.diagnosis : []) {
    const cond = ctx.resolve(d?.condition, r?.contained);
    if (cond?.resourceType === "Condition") push(conceptName(cond.code));
    else if (d?.condition?.concept) push(conceptName(d.condition.concept));
  }
  return out;
}

export function mapEncounterResource(
  r: any,
  ctx: FhirBundleCtx
): ImportedEncounter | null {
  if (r?.status === "entered-in-error") return null;
  const date = isoDate(r?.period?.start ?? r?.actualPeriod?.start);
  if (!date) return null;
  const end = isoDate(r?.period?.end ?? r?.actualPeriod?.end);
  const type = conceptName(Array.isArray(r?.type) ? r.type[0] : r?.type);
  const classCode = encounterClass(r?.class);
  // Attending clinician (participant[].individual) — prefer the named individual.
  const provider = providerFromRefs(
    (Array.isArray(r?.participant) ? r.participant : []).map(
      (p: any) => p?.individual ?? p?.actor
    ),
    ctx,
    r?.contained,
    "individual"
  );
  // Facility: the encounter location, else its serviceProvider organization.
  const location =
    providerFromRefs(
      (Array.isArray(r?.location) ? r.location : []).map(
        (l: any) => l?.location
      ),
      ctx,
      r?.contained,
      "organization"
    ) ??
    providerFromRefs(r?.serviceProvider, ctx, r?.contained, "organization");
  const diagnoses = encounterDiagnoses(r, ctx);
  // With a source id the key is stable + reprocess-idempotent; without one, fold in
  // the date/type/class so two id-less same-day visits don't collide. Kept under the
  // `ccda:encounter:` namespace the encounters sink already dedups on (FHIR resource
  // ids and CDA <id> extensions differ, so cross-format dedup here is best-effort).
  const external_id =
    r?.id != null
      ? `ccda:encounter:${r.id}`
      : `ccda:encounter:${date}:${(type ?? "").toLowerCase()}:${(
          classCode ?? ""
        ).toLowerCase()}`;
  return {
    date,
    end_date: end,
    type,
    class_code: classCode,
    reason: encounterReason(r),
    diagnoses,
    provider,
    location,
    // FHIR R4/R5 Encounter carries no plain free-text note field, so there is no
    // reliable visit summary to surface here (the CDA path fills this from a nested
    // Comment Activity).
    notes: null,
    external_id,
  };
}

// ---- Procedure ----

export function mapProcedureResource(
  r: any,
  ctx: FhirBundleCtx
): ImportedProcedure | null {
  if (r?.status === "entered-in-error" || r?.status === "not-done") return null;
  const name = conceptName(r?.code);
  if (!name) return null;
  // Prefer a billing ICD-10 coding, else the primary/first coding — mirrors the
  // CDA pickCode preference so the same procedure keys identically across formats.
  const { code, system } = pickCoding(r?.code, [ICD10]);
  const date = isoDate(
    r?.performedDateTime ?? r?.performedPeriod?.start ?? r?.performedString
  );
  // The performing clinician (performer[].actor) — prefer the named individual.
  const provider = providerFromRefs(
    (Array.isArray(r?.performer) ? r.performer : []).map((p: any) => p?.actor),
    ctx,
    r?.contained,
    "individual"
  );
  return {
    name,
    code,
    code_system: system,
    date,
    provider,
    external_id: procedureExternalId({ name, code, date }),
  };
}

// ---- FamilyMemberHistory ----

// The affected relative for a FamilyMemberHistory: the relationship CodeableConcept
// (its text/coding display), else null.
function familyRelation(r: any): string | null {
  return conceptName(r?.relationship);
}

// Whether the relative is deceased: `deceasedBoolean` true, or any of the
// `deceased[x]` variants being present, → 1; an explicit false → 0; else null.
function familyDeceased(r: any): number | null {
  if (r?.deceasedBoolean === true) return 1;
  if (r?.deceasedBoolean === false) return 0;
  if (
    r?.deceasedAge != null ||
    r?.deceasedRange != null ||
    r?.deceasedDate != null ||
    typeof r?.deceasedString === "string"
  )
    return 1;
  return null;
}

// One FamilyMemberHistory resource → one ImportedFamilyHistory row per condition it
// carries. relationship → relation, condition.code → the condition, condition
// .onsetAge → onset_age (years), deceased[x] → deceased.
export function mapFamilyMemberHistoryResource(
  r: any
): ImportedFamilyHistory[] {
  if (r?.status === "entered-in-error") return [];
  const relation = familyRelation(r);
  const deceased = familyDeceased(r);
  const out: ImportedFamilyHistory[] = [];
  for (const c of Array.isArray(r?.condition) ? r.condition : []) {
    const condition = conceptName(c?.code);
    if (!condition) continue;
    const { code, system } = pickCoding(c?.code, [ICD10]);
    // Only the per-condition onsetAge (age AT onset) — NOT the resource-level
    // FamilyMemberHistory.age[x] (the relative's age when RECORDED), which is a
    // different quantity and would misreport onset.
    const ageVal = c?.onsetAge?.value;
    const onsetAge = Number.isFinite(Number(ageVal))
      ? Math.round(Number(ageVal))
      : null;
    out.push({
      relation,
      condition,
      code,
      code_system: system,
      onset_age: onsetAge,
      deceased,
      external_id: familyHistoryExternalId({ relation, condition, code }),
    });
  }
  return out;
}

// ---- CarePlan ----

// One CarePlan resource → one ImportedCarePlanItem row per planned activity it
// carries. Each activity's detail codes the planned act (code → description),
// scheduled[x] → planned date, and status → status; the activity category (a
// CodeableConcept) classifies it. A CarePlan with NO activities still yields one
// summary row from the plan's own category/title so the plan isn't lost.
export function mapCarePlanResource(r: any): ImportedCarePlanItem[] {
  if (r?.status === "entered-in-error" || r?.status === "revoked") return [];
  const planStatus = typeof r?.status === "string" ? r.status : null;
  const activities = Array.isArray(r?.activity) ? r.activity : [];
  const out: ImportedCarePlanItem[] = [];
  for (const a of activities) {
    const d = a?.detail;
    const description =
      conceptName(d?.code) ??
      conceptName(Array.isArray(d?.category) ? d.category[0] : d?.category);
    if (!description) continue;
    const { code, system } = pickCoding(d?.code, [ICD10]);
    const category =
      conceptName(Array.isArray(d?.category) ? d.category[0] : d?.category) ??
      d?.kind ??
      null;
    const plannedDate = isoDate(
      d?.scheduledPeriod?.start ??
        d?.scheduledTiming?.event?.[0] ??
        d?.scheduledString
    );
    const status =
      (typeof d?.status === "string" ? d.status : null) ?? planStatus;
    out.push({
      description,
      code,
      code_system: system,
      category: typeof category === "string" ? category : null,
      planned_date: plannedDate,
      status,
      provider: null,
      external_id: carePlanExternalId({ description, code, plannedDate }),
    });
  }
  // No structured activities — fall back to a single summary row so the plan
  // registers (its title/category is the description).
  if (out.length === 0) {
    const description =
      (typeof r?.title === "string" && r.title.trim()
        ? r.title.trim()
        : null) ??
      conceptName(Array.isArray(r?.category) ? r.category[0] : r?.category);
    if (description) {
      out.push({
        description,
        code: null,
        code_system: null,
        category: conceptName(
          Array.isArray(r?.category) ? r.category[0] : r?.category
        ),
        planned_date: isoDate(r?.period?.start),
        status: planStatus,
        provider: null,
        external_id: carePlanExternalId({
          description,
          code: null,
          plannedDate: isoDate(r?.period?.start),
        }),
      });
    }
  }
  return out;
}

// ---- Goal ----

// One Goal resource → one ImportedCareGoal. description.text (else a coded target
// measure) → description, target[].dueDate → target date, lifecycleStatus → status.
export function mapGoalResource(r: any): ImportedCareGoal | null {
  if (r?.lifecycleStatus === "entered-in-error") return null;
  const target = Array.isArray(r?.target) ? r.target[0] : r?.target;
  const description =
    (typeof r?.description?.text === "string" && r.description.text.trim()
      ? r.description.text.trim()
      : null) ??
    conceptName(r?.description) ??
    conceptName(target?.measure);
  if (!description) return null;
  const { code, system } = pickCoding(r?.description ?? target?.measure, [
    ICD10,
  ]);
  const targetDate = isoDate(target?.dueDate);
  const status =
    typeof r?.lifecycleStatus === "string" ? r.lifecycleStatus : null;
  return {
    description,
    code,
    code_system: system,
    target_date: targetDate,
    status,
    external_id: careGoalExternalId({ description, code, targetDate }),
  };
}

// ---- DiagnosticReport ----

// A DiagnosticReport is a container of results. Its `result[]` entries usually ALSO
// appear as top-level Observations (mapped by the Observation loop, then deduped by
// external_id), so the value here is picking up Observations that live ONLY inside
// the report — its `contained` resources and any referenced result that resolves to
// one. Overlap with a top-level Observation collapses on the shared external_id.
export function recordsFromDiagnosticReport(
  r: any,
  idPrefix: string,
  ctx: FhirBundleCtx
): ImportedRecord[] {
  if (r?.status === "entered-in-error" || r?.status === "cancelled") return [];
  const out: ImportedRecord[] = [];
  const contained = Array.isArray(r?.contained) ? r.contained : [];
  for (const c of contained) {
    if (c?.resourceType === "Observation") {
      out.push(...observationRecords(c, idPrefix, ctx));
    }
  }
  for (const ref of Array.isArray(r?.result) ? r.result : []) {
    const obs = ctx.resolve(ref, contained);
    if (obs?.resourceType === "Observation") {
      out.push(...observationRecords(obs, idPrefix, ctx));
    }
  }
  return out;
}

// A FHIR Patient carries the subject's birthDate (YYYY-MM-DD), gender
// ("male"/"female"/…), and name. Sex/birthdate fill the profile when unset;
// the name is document provenance (medical_documents.patient_name).
export function mapPatientDemographics(r: any): ImportDemographics | null {
  const birthdate = isoDate(r?.birthDate);
  const sex =
    r?.gender === "male" ? "male" : r?.gender === "female" ? "female" : null;
  const name = humanName(r);
  if (!birthdate && !sex && !name) return null;
  return { sex, birthdate, name };
}

// ---- resource dispatch ----
