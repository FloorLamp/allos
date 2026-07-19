import {
  isDerivedPercentileLoinc,
  isNonAnalyteLoinc,
} from "../biomarker-loinc";
import {
  allergyExternalId,
  careGoalExternalId,
  carePlanExternalId,
  conditionExternalId,
  decideImportedConditionStatus,
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
  ImportedImagingStudy,
  ImportedImmunization,
  ImportedOpticalPrescription,
  ImportedProcedure,
  ImportedRecord,
} from "../health-import";
import type {
  AppointmentKind,
  AppointmentStatus,
  ImagingModality,
  OpticalKind,
} from "../types";
import { normalizeLaterality, normalizeModality } from "../imaging-study";
import {
  parseAxis,
  parseDiopter,
  parseMillimeters,
} from "../optical-prescription";
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
  loincFromFhirCode,
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
  // Drop non-analyte administrative rows (specimen dates, "Approved By", accession
  // numbers) and derived anthropometric percentiles the SAME way the CDA mapper does
  // (#681/#684/#722) — the shared isUnmappedLabLoinc already excludes them from the
  // unmapped-code report, so without this the FHIR path would persist them as junk
  // labs that never surface in that report (#693).
  return out.filter(
    (rec) =>
      !isNonAnalyteLoinc(rec.loinc) && !isDerivedPercentileLoinc(rec.loinc)
  );
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
  const clinicalStatus =
    firstCodingCode(r?.clinicalStatus) ?? conceptName(r?.clinicalStatus);
  const status = toConditionStatus(clinicalStatus);
  const onset = isoDate(r?.onsetDateTime ?? r?.onsetPeriod?.start);
  const resolved =
    status === "resolved"
      ? isoDate(r?.abatementDateTime ?? r?.abatementPeriod?.end)
      : null;
  // Import intelligence (#590), parity with the CDA path: downgrade a birth-event
  // or stale self-limited active row to resolved. A present clinicalStatus is
  // authoritative (never downgraded); onset is never fabricated.
  const decided = decideImportedConditionStatus({
    name,
    code,
    status,
    onsetDate: onset,
    resolvedDate: resolved,
    explicitStatus: clinicalStatus != null,
  });
  return {
    name,
    code,
    code_system: system,
    status: decided.status,
    onset_date: decided.onset_date,
    resolved_date: decided.resolved_date,
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
  if (/\b(hearing|audiolog|audiogram|audiometr)/.test(t)) return "hearing";
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

// ---- Imaging (#708 → #702): ImagingStudy / imaging DiagnosticReport / imaging
// DocumentReference → a structured imaging_studies row ----
//
// Deterministic study metadata + the radiologist's impression, recovered from the
// FHIR resources Epic/Apple Health already export. Normalization is delegated to the
// ONE shared coercion (lib/imaging-study.ts normalizeModality/normalizeLaterality) —
// no second modality/laterality parser is rolled here (the "one question, one
// computation" rule); the only FHIR-specific bridge is a DICOM-modality-code lookup
// (a code vocabulary normalizeModality doesn't speak), which still falls through to
// normalizeModality on the coding's display text.

// The rendered-report narrative cap: a decoded inline attachment / conclusion is
// stored as the impression, capped so a runaway document can't bloat the row.
const IMAGING_NARRATIVE_MAX = 8000;

// DICOM acquisition-modality codes (ImagingStudy.modality / .series.modality,
// DiagnosticReport imaging categories) → our modality enum. A code vocabulary
// normalizeModality (which reads report PHRASINGS) can't resolve, so this small
// bridge maps the standard codes; anything not listed falls back to
// normalizeModality on the coding display. Mammography (MG) is an x-ray study.
const DICOM_MODALITY: Record<string, ImagingModality> = {
  CT: "ct",
  CTA: "ct",
  MR: "mri",
  MRI: "mri",
  MRA: "mri",
  NMR: "mri",
  US: "ultrasound",
  BDUS: "ultrasound",
  ECHO: "ultrasound",
  EC: "ultrasound",
  CR: "x-ray",
  DX: "x-ray",
  DR: "x-ray",
  XR: "x-ray",
  RF: "x-ray",
  XA: "x-ray",
  MG: "x-ray",
  BMD: "dexa",
  DXA: "dexa",
  BONE: "dexa",
};

// SNOMED CT body-laterality codes (ImagingStudy.series.laterality) → our enum, for
// the code-only case where normalizeLaterality's text path finds no display.
const SNOMED_LATERALITY: Record<string, "left" | "right" | "bilateral"> = {
  "7771000": "left",
  "24028007": "right",
  "51440002": "bilateral",
};

// v2-0074 diagnostic-service section codes that denote an imaging service, so a
// DiagnosticReport's category classifies it as imaging vs a lab/path report.
const IMAGING_SERVICE_CODES = new Set([
  "RAD",
  "IMG",
  "US",
  "CT",
  "MR",
  "NMR",
  "XR",
  "MRI",
  "CTH",
  "CUS",
  "ECHO",
  "NMS",
  "OUS",
  "RUS",
  "VUS",
  "MG",
  "BMD",
  "NM",
  "XA",
  "RF",
  "CR",
  "DX",
]);

// A free-text signal that a report/document is imaging/radiology (belt to the coded
// classifier — a DiagnosticReport/DocumentReference whose category codes are absent
// but whose title says "CT CHEST" still classifies).
const IMAGING_TEXT_RE =
  /radiolog|imaging|x-?ray|ultrasound|sonogr|\bct\b|\bmri\b|\bmr\b|mammogr|tomograph|angiogram|densitometr|\bdexa\b|nuclear med/i;

function ccCodings(cc: any): any[] {
  return Array.isArray(cc?.coding) ? cc.coding : [];
}

function codingDisplay(coding: any): string | null {
  const d = coding?.display;
  return typeof d === "string" && d.trim() ? d.trim() : null;
}

// A CodeableConcept[] (e.g. DiagnosticReport.conclusionCode) → its joined display
// terms, or null.
function conceptListText(list: any): string | null {
  const out = (Array.isArray(list) ? list : list != null ? [list] : [])
    .map((cc) => conceptName(cc))
    .filter((s): s is string => !!s);
  return out.length ? out.join("; ") : null;
}

// Coerce a modality onto the enum from a set of Codings (DICOM code first, then the
// coding display via the shared normalizer), with a free-text fallback. Returns the
// safe 'other' default when nothing resolves (an unclassified study is still stored).
function modalityFromCodings(
  codings: any[],
  fallbackText: string | null
): ImagingModality {
  for (const c of codings) {
    const code = c?.code != null ? String(c.code).toUpperCase() : null;
    if (code && DICOM_MODALITY[code]) return DICOM_MODALITY[code];
    const m = normalizeModality(codingDisplay(c));
    if (m !== "other") return m;
  }
  return normalizeModality(fallbackText);
}

function lateralityFromCoding(
  coding: any
): "left" | "right" | "bilateral" | "na" | null {
  const byText = normalizeLaterality(codingDisplay(coding));
  if (byText) return byText;
  const code = coding?.code != null ? String(coding.code) : null;
  return code && SNOMED_LATERALITY[code] ? SNOMED_LATERALITY[code] : null;
}

// Collapse HTML → plain text (presentedForm / DocumentReference rendered reports are
// often text/html). Strip script/style bodies + tags, decode the handful of entities
// that survive, and normalize whitespace.
function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function capNarrative(s: string): string {
  const t = s.trim();
  return t.length > IMAGING_NARRATIVE_MAX
    ? t.slice(0, IMAGING_NARRATIVE_MAX).trimEnd() + "…"
    : t;
}

// Decode ONE inline FHIR Attachment to plain text — ONLY when it carries inline
// base64 `data` with a text-ish contentType. A binary attachment (application/pdf,
// image/*) or a remote `url`-only reference returns null: we DELIBERATELY never fetch
// an external URL (no auto-egress) and never blind-decode binary (that's the deferred
// AI-extraction path). #708 item 4, inline-text boundary.
function decodeInlineAttachmentText(att: any): string | null {
  if (!att || typeof att.data !== "string" || !att.data.trim()) return null;
  const ct = typeof att.contentType === "string" ? att.contentType : "";
  const isHtml = /html|xml/i.test(ct);
  const isText = /text\/|rtf/i.test(ct) || isHtml;
  if (!isText) return null; // binary / unknown type → not decoded
  let decoded: string;
  try {
    decoded = Buffer.from(att.data, "base64").toString("utf8");
  } catch {
    return null;
  }
  const text = isHtml
    ? stripHtml(decoded)
    : decoded.replace(/\s+/g, " ").trim();
  return text || null;
}

// The joined inline-text of an Attachment[] (presentedForm / DocumentReference
// content), or null when none is inline-decodable.
function attachmentsText(atts: any): string | null {
  const list = Array.isArray(atts) ? atts : atts != null ? [atts] : [];
  const parts = list
    .map((a) => decodeInlineAttachmentText(a))
    .filter((s): s is string => !!s);
  return parts.length ? parts.join("\n\n") : null;
}

// A stable external_id for a mapped imaging row. Prefers the resource id (idempotent
// re-import); falls back to a composite of the discriminating parts when a bundle
// omits `id`.
function imagingExternalId(
  idPrefix: string,
  kind: string,
  r: any,
  fallbackParts: (string | null)[]
): string {
  const id =
    r?.id != null && String(r.id).trim()
      ? String(r.id).trim()
      : fallbackParts.filter(Boolean).join("-") || "study";
  return `${idPrefix}:imaging:${kind}:${id}`;
}

// Does a DiagnosticReport / DocumentReference classify as imaging/radiology? Coded
// (v2-0074 service codes on category) or by free-text title (code/type/category
// display). Non-imaging reports (pathology, labs) return false so their narrative is
// routed to the fallback record instead of fabricating an imaging study.
function looksLikeImagingReport(r: any): boolean {
  const categories = Array.isArray(r?.category)
    ? r.category
    : r?.category != null
      ? [r.category]
      : [];
  for (const cat of categories) {
    for (const c of ccCodings(cat)) {
      const code = c?.code != null ? String(c.code).toUpperCase() : null;
      if (code && IMAGING_SERVICE_CODES.has(code)) return true;
    }
  }
  const texts = [
    conceptName(r?.code),
    conceptName(r?.type),
    ...categories.map((cat: any) => conceptName(cat)),
  ].filter((s): s is string => !!s);
  return texts.some((t) => IMAGING_TEXT_RE.test(t));
}

// A FHIR ImagingStudy → a structured imaging study. modality from the top-level /
// per-series DICOM codes; body region + laterality from the first series carrying
// them; the study's description/notes as the impression; reasonCode as the
// indication; `started` as the date. entered-in-error / cancelled → dropped.
export function mapImagingStudyResource(
  r: any,
  idPrefix: string
): ImportedImagingStudy | null {
  if (r?.status === "entered-in-error" || r?.status === "cancelled")
    return null;
  const series = Array.isArray(r?.series) ? r.series : [];
  const modalityCodings = [
    ...(Array.isArray(r?.modality)
      ? r.modality
      : r?.modality
        ? [r.modality]
        : []),
    ...series.map((s: any) => s?.modality).filter(Boolean),
  ];
  const modality = modalityFromCodings(
    modalityCodings,
    typeof r?.description === "string" ? r.description : null
  );
  const bodyCoding = series.map((s: any) => s?.bodySite).find(Boolean);
  const body_region = bodyCoding ? codingDisplay(bodyCoding) : null;
  const latCoding = series.map((s: any) => s?.laterality).find(Boolean);
  const laterality = latCoding ? lateralityFromCoding(latCoding) : null;
  const noteText = (Array.isArray(r?.note) ? r.note : [])
    .map((n: any) => (typeof n?.text === "string" ? n.text.trim() : null))
    .filter((s: string | null): s is string => !!s)
    .join("\n");
  const impressionRaw =
    [typeof r?.description === "string" ? r.description.trim() : "", noteText]
      .filter(Boolean)
      .join("\n") || null;
  const study_date = isoDate(r?.started);
  // Drop a study that carries no distinguishing signal at all (no specific
  // modality, no region, no date, no narrative) — nothing worth a row.
  if (modality === "other" && !body_region && !study_date && !impressionRaw)
    return null;
  return {
    modality,
    body_region,
    laterality,
    contrast: false,
    contrast_agent: null,
    study_date,
    impression: impressionRaw ? capNarrative(impressionRaw) : null,
    indication: conceptListText(r?.reasonCode),
    status: typeof r?.status === "string" ? r.status : null,
    external_id: imagingExternalId(idPrefix, "study", r, [
      modality,
      study_date,
    ]),
  };
}

// A FHIR DiagnosticReport → its inner Observation records PLUS its narrative:
//  - an IMAGING report → a structured imaging study whose impression is the
//    conclusion (+ conclusionCode terms + any inline-decodable presentedForm text);
//  - any OTHER report (pathology, cardiology, …) with a conclusion → a value-less
//    `lab` medical_records row carrying the narrative in `value` (the least-surprising
//    existing home — a qualitative/narrative lab reading; imaging has no dedicated
//    non-radiology record type yet). Both destinations are import-footprint-covered
//    (imaging_studies / medical_records key on document_id).
// presentedForm attachments are captured ONLY when inline-decodable text; binary/
// remote rendered reports are NOT fetched (no auto-egress) — the deferred item-4 tail.
export function mapDiagnosticReport(
  r: any,
  idPrefix: string,
  ctx: FhirBundleCtx
): { records: ImportedRecord[]; imagingStudies: ImportedImagingStudy[] } {
  const records = recordsFromDiagnosticReport(r, idPrefix, ctx);
  if (r?.status === "entered-in-error" || r?.status === "cancelled")
    return { records, imagingStudies: [] };
  const conclusion =
    typeof r?.conclusion === "string" && r.conclusion.trim()
      ? r.conclusion.trim()
      : null;
  const conclusionCodeText = conceptListText(r?.conclusionCode);
  const formText = attachmentsText(r?.presentedForm);
  const narrative =
    [conclusion, conclusionCodeText, formText].filter(Boolean).join("\n\n") ||
    null;
  if (!narrative) return { records, imagingStudies: [] };
  const date = isoDate(
    r?.effectiveDateTime ?? r?.issued ?? r?.effectivePeriod?.start
  );
  if (looksLikeImagingReport(r)) {
    const categoryCodings = (
      Array.isArray(r?.category) ? r.category : r?.category ? [r.category] : []
    ).flatMap((cat: any) => ccCodings(cat));
    const modality = modalityFromCodings(
      [...ccCodings(r?.code), ...categoryCodings],
      conceptName(r?.code)
    );
    return {
      records,
      imagingStudies: [
        {
          modality,
          body_region: null,
          laterality: null,
          contrast: false,
          contrast_agent: null,
          study_date: date,
          impression: capNarrative(narrative),
          indication: null,
          status: typeof r?.status === "string" ? r.status : null,
          external_id: imagingExternalId(idPrefix, "report", r, [
            modality,
            date,
          ]),
        },
      ],
    };
  }
  // Non-imaging report narrative → a value-less lab record. A record needs a date to
  // place it on the timeline/series; a dateless report narrative is dropped.
  if (!date) return { records, imagingStudies: [] };
  const name = conceptName(r?.code) ?? "Diagnostic Report";
  const loinc = loincFromFhirCode(r?.code);
  const drId =
    r?.id != null && String(r.id).trim()
      ? String(r.id).trim()
      : `${name}-${date}`;
  const narrativeRecord: ImportedRecord = {
    category: "lab",
    name,
    canonical: name,
    value: capNarrative(narrative),
    value_num: null,
    unit: null,
    date,
    external_id: `${idPrefix}:dr-conclusion:${drId}`,
    loinc: loinc ?? null,
    provider: null,
  };
  return { records: [...records, narrativeRecord], imagingStudies: [] };
}

// A FHIR DocumentReference → a structured imaging study, ONLY when it is an
// imaging/radiology document carrying an inline-decodable text rendered report (#708
// item 4, inline-text boundary). A non-imaging document, a binary attachment
// (application/pdf, image/*), or a remote `url`-only reference returns null — we
// never auto-fetch an external URL and never blind-decode binary here (that rendered
// report → medical_documents → AI-extraction path is the deferred item-4 tail).
export function mapDocumentReferenceImaging(
  r: any,
  idPrefix: string
): ImportedImagingStudy | null {
  if (r?.status === "entered-in-error" || r?.docStatus === "entered-in-error")
    return null;
  if (!looksLikeImagingReport(r)) return null;
  const atts = (Array.isArray(r?.content) ? r.content : [])
    .map((c: any) => c?.attachment)
    .filter(Boolean);
  const text = attachmentsText(atts);
  if (!text) return null; // binary / remote / no inline text — not ingested
  const modality = modalityFromCodings(
    ccCodings(r?.type),
    conceptName(r?.type)
  );
  const attCreation = atts
    .map((a: any) => isoDate(a?.creation))
    .find((d: string | null) => !!d);
  const study_date = isoDate(r?.date) ?? attCreation ?? null;
  return {
    modality,
    body_region: null,
    laterality: null,
    contrast: false,
    contrast_agent: null,
    study_date,
    impression: capNarrative(text),
    indication: null,
    status:
      typeof r?.docStatus === "string"
        ? r.docStatus
        : typeof r?.status === "string"
          ? r.status
          : null,
    external_id: imagingExternalId(idPrefix, "docref", r, [study_date]),
  };
}

// A stable dedup key for a VisionPrescription: the resource id, else a fallback
// composed from the kind + issued date. Mirrors imagingExternalId.
function visionExternalId(
  idPrefix: string,
  r: any,
  fallbackParts: (string | null)[]
): string {
  const id =
    r?.id != null && String(r.id).trim()
      ? String(r.id).trim()
      : fallbackParts.filter(Boolean).join("-") || "rx";
  return `${idPrefix}:vision:${id}`;
}

// Pick the prescription kind from the lensSpecification product codings — the FHIR
// ex-visionprescriptionproduct code is `lens` (eyeglasses) or `contact` (contact
// lens). We map the code EXPLICITLY (never through normalizeOpticalKind, whose
// "lens" substring rule means eyeglasses, contradicting this vocabulary); when the
// code is absent, a filled backCurve / power / diameter is the contact-lens tell.
function visionLensKind(specs: any[]): OpticalKind {
  for (const s of specs) {
    for (const c of ccCodings(s?.product)) {
      const code =
        typeof c?.code === "string" ? c.code.trim().toLowerCase() : "";
      if (code === "contact") return "contacts";
      if (code === "lens") return "glasses";
    }
  }
  if (
    specs.some(
      (s) => s?.backCurve != null || s?.power != null || s?.diameter != null
    )
  )
    return "contacts";
  return "glasses";
}

// Interpupillary distance (mm): R4 VisionPrescription has NO standard PD element, so
// read it best-effort from a resource- or spec-level extension whose url names it
// ("…pupillaryDistance"). Absent in most bundles → null. #708 "PD if present".
function readVisionPd(r: any, specs: any[]): number | null {
  const exts = [
    ...(Array.isArray(r?.extension) ? r.extension : []),
    ...specs.flatMap((s: any) =>
      Array.isArray(s?.extension) ? s.extension : []
    ),
  ];
  for (const e of exts) {
    const url = typeof e?.url === "string" ? e.url.toLowerCase() : "";
    if (!/pupil/.test(url)) continue;
    const pd = parseMillimeters(
      e?.valueQuantity?.value ?? e?.valueDecimal ?? e?.valueInteger
    );
    if (pd != null) return pd;
  }
  return null;
}

// Prism corrections + free-text notes across both eyes, folded into one notes string
// (the optical_prescriptions row has no prism column — prism is preserved as text).
function visionNotes(od: any, os: any): string | null {
  const parts: string[] = [];
  for (const [label, s] of [
    ["OD", od],
    ["OS", os],
  ] as const) {
    for (const p of Array.isArray(s?.prism) ? s.prism : []) {
      const amt = parseDiopter(p?.amount);
      const base = typeof p?.base === "string" ? p.base.trim() : "";
      if (amt != null)
        parts.push(`${label} prism ${amt}${base ? ` base ${base}` : ""}`);
    }
    for (const n of Array.isArray(s?.note) ? s.note : []) {
      const t = typeof n?.text === "string" ? n.text.trim() : "";
      if (t) parts.push(`${label}: ${t}`);
    }
  }
  return parts.length ? parts.join("; ") : null;
}

// A FHIR R4 VisionPrescription → ONE structured optical prescription (#708 → #697).
// The per-eye lensSpecification entries fold together (eye = right → OD, left → OS),
// the product coding picks glasses vs contacts, dateWritten is the issued date, and
// the prescriber reference resolves into the shared providers registry. EVERY dioptre
// / axis / mm value runs through the shared optical-prescription parsers (the ONE Rx
// coercion, #221), so an off-vocabulary value can't reach — let alone fail — the
// INSERT. prism is captured as a note; PD comes from an extension when present.
// draft / cancelled / entered-in-error → dropped; so is an Rx with no refraction and
// no contact-lens spec (nothing distinguishing to store).
export function mapVisionPrescription(
  r: any,
  ctx: FhirBundleCtx
): ImportedOpticalPrescription | null {
  const status = r?.status;
  if (
    status === "entered-in-error" ||
    status === "cancelled" ||
    status === "draft"
  )
    return null;
  const specs = Array.isArray(r?.lensSpecification) ? r.lensSpecification : [];
  const eyeSpec = (eye: string) =>
    specs.find(
      (s: any) =>
        typeof s?.eye === "string" && s.eye.trim().toLowerCase() === eye
    ) ?? null;
  const od = eyeSpec("right");
  const os = eyeSpec("left");

  const kind = visionLensKind(specs);
  const od_sphere = parseDiopter(od?.sphere);
  const od_cylinder = parseDiopter(od?.cylinder);
  const od_axis = parseAxis(od?.axis);
  const od_add = parseDiopter(od?.add);
  const os_sphere = parseDiopter(os?.sphere);
  const os_cylinder = parseDiopter(os?.cylinder);
  const os_axis = parseAxis(os?.axis);
  const os_add = parseDiopter(os?.add);

  // Contact-lens extras (mm) — prefer the right eye's value, else the left's.
  const base_curve = parseMillimeters(od?.backCurve ?? os?.backCurve);
  const diameter = parseMillimeters(od?.diameter ?? os?.diameter);
  const brand =
    [od?.brand, os?.brand]
      .map((b) => (typeof b === "string" && b.trim() ? b.trim() : null))
      .find(Boolean) ?? null;

  const issued_date = isoDate(r?.dateWritten ?? r?.created);
  const provider = providerFromRefs(
    r?.prescriber,
    ctx,
    r?.contained,
    "individual"
  );

  const hasRefraction =
    od_sphere != null ||
    od_cylinder != null ||
    od_add != null ||
    os_sphere != null ||
    os_cylinder != null ||
    os_add != null;
  // Nothing distinguishing to store — no per-eye power AND no contact-lens geometry.
  if (!hasRefraction && base_curve == null && diameter == null) return null;

  return {
    kind,
    od_sphere,
    od_cylinder,
    od_axis,
    od_add,
    os_sphere,
    os_cylinder,
    os_axis,
    os_add,
    pd: readVisionPd(r, specs),
    base_curve,
    diameter,
    brand,
    issued_date,
    expiry_date: null,
    provider,
    notes: visionNotes(od, os),
    external_id: visionExternalId(ctx.idPrefix, r, [kind, issued_date]),
  };
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
