import type { AppointmentKind, AppointmentStatus } from "./types";

// FHIR R4 bundle EXPORT — the inverse of lib/fhir.ts's import mapping (issue #18).
// Pure: no DB, no network, no filesystem. Given the profile's clinical passport as
// plain provider-neutral rows (conditions, allergies, procedures, immunizations,
// lab/vitals observations, and medications), it emits a FHIR R4 `collection` Bundle
// that the app's OWN importer (parseFhirBundle in lib/fhir.ts) can re-read. The
// unit test round-trips a bundle through parseFhirBundle and compares the
// essentials, so the two directions can't silently drift.
//
// Fidelity is best-effort by design and documented where it's lossy:
//   - medical_records carries no LOINC, so exported Observations have only a text
//     code; the importer classifies them all as `lab` (it routes vitals by LOINC).
//   - immunizations stores a display name, not a CVX code, so the vaccineCode is
//     carried as `text` and the importer re-derives a catalog slug from the name.
//   - medications carry no authored/effective date in the app, so the export uses
//     the row's own recorded date (created_at) as the FHIR authoredOn.
// The clinical identity that matters for re-import — coded name, status, dates,
// values — round-trips cleanly.

// ---- coding-system label <-> URI ----

// The human labels lib/fhir.ts's systemLabel() produces, mapped back to canonical
// FHIR system URIs so a re-import's systemLabel() recovers the same label. An
// unknown label is emitted as-is (systemLabel falls back to the raw string), so it
// still round-trips.
const LABEL_TO_URI: Record<string, string> = {
  "ICD-10-CM": "http://hl7.org/fhir/sid/icd-10-cm",
  "ICD-9-CM": "http://hl7.org/fhir/sid/icd-9-cm",
  "SNOMED CT": "http://snomed.info/sct",
  RxNorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  LOINC: "http://loinc.org",
};

function systemUri(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  return LABEL_TO_URI[label] ?? label;
}

interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}
interface FhirCodeableConcept {
  text?: string;
  coding?: FhirCoding[];
}

// A CodeableConcept from a display name plus an optional (code, system-label). The
// text is always the name; a coding is added only when a code is present.
function concept(
  text: string,
  code?: string | null,
  systemLabel?: string | null
): FhirCodeableConcept {
  const cc: FhirCodeableConcept = { text };
  if (code) {
    cc.coding = [{ system: systemUri(systemLabel), code, display: text }];
  }
  return cc;
}

// A clinical-status CodeableConcept whose first coding.code is the status token —
// the shape lib/fhir.ts reads via firstCodingCode() → normalizeClinicalStatus().
function statusConcept(code: string): FhirCodeableConcept {
  return { coding: [{ code }] };
}

// ---- provider-neutral input shapes (subsets of the DB rows) ----

export interface FhirExportEmergencyContact {
  name: string;
  phone: string;
  relation: string;
}

export interface FhirExportSmoking {
  status: string | null; // never | former | current | ...
  packYears: number | null;
  quitYear: number | null;
}

export interface FhirExportProfile {
  name: string | null;
  sex: "male" | "female" | null;
  birthdate: string | null; // YYYY-MM-DD
  // Settings-tier clinical facts (issue #465). The app's own importer does not read
  // these back, so they ride on the Patient as best-effort provenance (contact +
  // Allos extensions) rather than round-tripping — but they no longer VANISH from the
  // clinical passport the way name/sex/DOB used to be the ONLY demographics exported.
  bloodType?: string | null;
  emergencyContact?: FhirExportEmergencyContact | null;
  smoking?: FhirExportSmoking | null;
}

export interface FhirExportCondition {
  name: string;
  code: string | null;
  code_system: string | null;
  status: string; // active | inactive | resolved
  onset_date: string | null;
  resolved_date: string | null;
}

export interface FhirExportAllergy {
  substance: string;
  substance_code: string | null;
  substance_code_system: string | null;
  reaction: string | null;
  severity: string | null;
  status: string;
  onset_date: string | null;
}

export interface FhirExportProcedure {
  name: string;
  code: string | null;
  code_system: string | null;
  date: string | null;
}

export interface FhirExportImmunization {
  vaccine: string;
  date: string; // YYYY-MM-DD
  dose_label: string | null;
}

export interface FhirExportObservation {
  name: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  date: string; // YYYY-MM-DD
}

export interface FhirExportMedication {
  name: string;
  dosage: string | null;
  date: string; // YYYY-MM-DD (the recorded date used as authoredOn)
  active: boolean;
}

export interface FhirExportEncounter {
  date: string; // YYYY-MM-DD
  end_date: string | null;
  type: string | null;
  class_code: string | null;
  reason: string | null;
  diagnoses: string[];
}

export interface FhirExportFamilyHistory {
  relation: string | null;
  condition: string;
  code: string | null;
  code_system: string | null;
  onset_age: number | null;
  deceased: number | null; // 1 | 0 | null
}

export interface FhirExportCarePlanItem {
  description: string;
  code: string | null;
  code_system: string | null;
  category: string | null;
  planned_date: string | null;
  status: string | null;
}

export interface FhirExportCareGoal {
  description: string;
  code: string | null;
  code_system: string | null;
  target_date: string | null;
  status: string | null;
}

// A scheduled appointment for the FHIR export (issue #416). The appointments table
// is ALSO a flat export dataset, so this FHIR emission exists mainly to keep the
// exporter symmetric with the importer's Appointment mapper — full-fidelity
// portability rides on the dataset.
export interface FhirExportAppointment {
  scheduled_at: string;
  status: AppointmentStatus;
  title: string | null;
  location: string | null;
  notes: string | null;
  kind: AppointmentKind | null;
}

export interface FhirExportInput {
  profile?: FhirExportProfile | null;
  conditions: FhirExportCondition[];
  allergies: FhirExportAllergy[];
  procedures: FhirExportProcedure[];
  immunizations: FhirExportImmunization[];
  observations: FhirExportObservation[];
  medications: FhirExportMedication[];
  // Added by #465 so the exporter is symmetric with the importer, which already
  // parses Encounter / FamilyMemberHistory / CarePlan / Goal. Optional (default []) so
  // existing callers/tests that build a partial input stay valid.
  encounters?: FhirExportEncounter[];
  familyHistory?: FhirExportFamilyHistory[];
  carePlanItems?: FhirExportCarePlanItem[];
  careGoals?: FhirExportCareGoal[];
  // Scheduled appointments (#416). Optional (default []) so existing callers stay valid.
  appointments?: FhirExportAppointment[];
}

// The FHIR resourceTypes this exporter emits. Bound in a DB-tier test (issue #465)
// against the importer's consumed set so the two directions can't silently drift —
// every clinical domain the app can IMPORT from a bundle it can also EXPORT.
export const FHIR_EXPORT_RESOURCE_TYPES = [
  "Patient",
  "Condition",
  "AllergyIntolerance",
  "Procedure",
  "Immunization",
  "Observation",
  "MedicationRequest",
  "Encounter",
  "FamilyMemberHistory",
  "CarePlan",
  "Goal",
  "Appointment",
] as const;

export interface FhirBundleEntry {
  fullUrl: string;
  resource: Record<string, unknown>;
}
export interface FhirBundle {
  resourceType: "Bundle";
  type: "collection";
  entry: FhirBundleEntry[];
}

// ---- resource builders (inverse of each lib/fhir.ts mapper) ----

function patientResource(p: FhirExportProfile): Record<string, unknown> {
  const r: Record<string, unknown> = { resourceType: "Patient" };
  if (p.sex) r.gender = p.sex;
  if (p.birthdate) r.birthDate = p.birthdate;
  if (p.name && p.name.trim()) r.name = [{ text: p.name.trim() }];

  // Settings-tier clinical facts (#465). Emergency contact → Patient.contact
  // (standard FHIR); blood type + smoking → Allos extensions (no standard Patient
  // element). Best-effort provenance — the importer ignores these — but they are no
  // longer dropped entirely from the exported passport.
  const ec = p.emergencyContact;
  if (ec && (ec.name.trim() || ec.phone.trim())) {
    const contact: Record<string, unknown> = {};
    if (ec.name.trim()) contact.name = { text: ec.name.trim() };
    if (ec.phone.trim())
      contact.telecom = [{ system: "phone", value: ec.phone.trim() }];
    if (ec.relation.trim())
      contact.relationship = [{ text: ec.relation.trim() }];
    r.contact = [contact];
  }
  const extension: Record<string, unknown>[] = [];
  if (p.bloodType && p.bloodType.trim())
    extension.push({
      url: "urn:allos:blood-type",
      valueString: p.bloodType.trim(),
    });
  if (p.smoking && p.smoking.status) {
    const parts = [p.smoking.status];
    if (p.smoking.packYears != null)
      parts.push(`${p.smoking.packYears} pack-years`);
    if (p.smoking.quitYear != null) parts.push(`quit ${p.smoking.quitYear}`);
    extension.push({
      url: "urn:allos:smoking-history",
      valueString: parts.join("; "),
    });
  }
  if (extension.length) r.extension = extension;
  return r;
}

function conditionResource(c: FhirExportCondition): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Condition",
    clinicalStatus: statusConcept(c.status),
    code: concept(c.name, c.code, c.code_system),
  };
  if (c.onset_date) r.onsetDateTime = c.onset_date;
  if (c.resolved_date) r.abatementDateTime = c.resolved_date;
  return r;
}

function allergyResource(a: FhirExportAllergy): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "AllergyIntolerance",
    clinicalStatus: statusConcept(a.status),
    code: concept(a.substance, a.substance_code, a.substance_code_system),
  };
  if (a.onset_date) r.onsetDateTime = a.onset_date;
  if (a.reaction || a.severity) {
    const reaction: Record<string, unknown> = {
      manifestation: [{ text: a.reaction ?? a.substance }],
    };
    if (a.severity) reaction.severity = a.severity;
    r.reaction = [reaction];
  }
  return r;
}

function procedureResource(p: FhirExportProcedure): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Procedure",
    status: "completed",
    code: concept(p.name, p.code, p.code_system),
  };
  if (p.date) r.performedDateTime = p.date;
  return r;
}

function immunizationResource(
  im: FhirExportImmunization
): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Immunization",
    status: "completed",
    vaccineCode: { text: im.vaccine },
    occurrenceDateTime: im.date,
  };
  if (im.dose_label) {
    r.protocolApplied = [{ doseNumberString: im.dose_label }];
  }
  return r;
}

function observationResource(
  o: FhirExportObservation
): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Observation",
    status: "final",
    code: concept(o.name),
    effectiveDateTime: o.date,
  };
  if (o.value_num != null) {
    const vq: Record<string, unknown> = { value: o.value_num };
    if (o.unit) vq.unit = o.unit;
    r.valueQuantity = vq;
  } else if (o.value != null) {
    r.valueString = o.value;
  }
  return r;
}

function medicationResource(m: FhirExportMedication): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "MedicationRequest",
    status: m.active ? "active" : "completed",
    medicationCodeableConcept: concept(m.name, null, "RxNorm"),
    authoredOn: m.date,
  };
  if (m.dosage && m.dosage.trim()) {
    r.dosageInstruction = [{ text: m.dosage.trim() }];
  }
  return r;
}

// Inverse of mapEncounterResource: period.start/end, a single-coding class, a text
// type, a reasonCode, and inline CodeableReference diagnoses the importer resolves.
function encounterResource(e: FhirExportEncounter): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Encounter",
    status: "finished",
    period: {
      start: e.date,
      ...(e.end_date ? { end: e.end_date } : {}),
    },
  };
  if (e.class_code) r.class = { code: e.class_code };
  if (e.type) r.type = [concept(e.type)];
  if (e.reason) r.reasonCode = [concept(e.reason)];
  if (e.diagnoses.length)
    r.diagnosis = e.diagnoses.map((d) => ({
      condition: { concept: concept(d) },
    }));
  return r;
}

// Inverse of mapFamilyMemberHistoryResource: one resource per stored row (each row is
// already one relation×condition). The condition's onsetAge carries the age at onset.
function familyMemberHistoryResource(
  f: FhirExportFamilyHistory
): Record<string, unknown> {
  const cond: Record<string, unknown> = {
    code: concept(f.condition, f.code, f.code_system),
  };
  if (f.onset_age != null) cond.onsetAge = { value: f.onset_age, unit: "a" };
  const r: Record<string, unknown> = {
    resourceType: "FamilyMemberHistory",
    status: "completed",
    condition: [cond],
  };
  if (f.relation) r.relationship = concept(f.relation);
  if (f.deceased != null) r.deceasedBoolean = f.deceased === 1;
  return r;
}

// Inverse of mapCarePlanResource: a single-activity plan whose detail codes the
// planned act, its category, scheduled date, and status.
function carePlanResource(c: FhirExportCarePlanItem): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    code: concept(c.description, c.code, c.code_system),
  };
  if (c.category) detail.category = [{ text: c.category }];
  if (c.planned_date) detail.scheduledPeriod = { start: c.planned_date };
  if (c.status) detail.status = c.status;
  return {
    resourceType: "CarePlan",
    // CarePlan.status is required; the row's status is a free-text activity status, so
    // keep the plan-level status neutral-active (the importer reads the detail.status).
    status: "active",
    activity: [{ detail }],
  };
}

// Inverse of mapGoalResource: description.text (+ optional coding), a due date, and
// the lifecycle status.
function goalResource(g: FhirExportCareGoal): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Goal",
    lifecycleStatus: g.status && g.status.trim() ? g.status : "active",
    description: concept(g.description, g.code, g.code_system),
  };
  if (g.target_date) r.target = [{ dueDate: g.target_date }];
  return r;
}

// Inverse of mapAppointmentResource: the lifecycle status back to a FHIR value,
// the scheduled date/time as `start`, the title as `description`, notes as `comment`,
// and the kind echoed as a serviceType text so the importer can re-map it.
const APPOINTMENT_STATUS_TO_FHIR: Record<AppointmentStatus, string> = {
  scheduled: "booked",
  completed: "fulfilled",
  cancelled: "cancelled",
};
function appointmentResource(
  a: FhirExportAppointment
): Record<string, unknown> {
  const r: Record<string, unknown> = {
    resourceType: "Appointment",
    status: APPOINTMENT_STATUS_TO_FHIR[a.status] ?? "booked",
    start: a.scheduled_at,
  };
  if (a.title && a.title.trim()) r.description = a.title.trim();
  if (a.notes && a.notes.trim()) r.comment = a.notes.trim();
  if (a.kind) r.serviceType = [{ text: a.kind }];
  if (a.location && a.location.trim())
    r.participant = [
      {
        actor: {
          reference: `Location/${a.location.trim()}`,
          display: a.location.trim(),
        },
        status: "accepted",
      },
    ];
  return r;
}

// Build the FHIR R4 collection Bundle. Every entry gets a stable synthetic id +
// fullUrl (urn:allos:<type>:<n>) so the importer's reference resolver has keys to
// index; nothing in this bundle actually cross-references, but well-formed entries
// keep the importer's coverage/report logic happy.
export function buildFhirBundle(input: FhirExportInput): FhirBundle {
  const entry: FhirBundleEntry[] = [];
  let seq = 0;
  const add = (type: string, resource: Record<string, unknown>) => {
    seq += 1;
    resource.id = `${type}-${seq}`;
    entry.push({ fullUrl: `urn:allos:${type}:${seq}`, resource });
  };

  if (input.profile) add("patient", patientResource(input.profile));
  for (const c of input.conditions) add("condition", conditionResource(c));
  for (const a of input.allergies) add("allergy", allergyResource(a));
  for (const p of input.procedures) add("procedure", procedureResource(p));
  for (const im of input.immunizations)
    add("immunization", immunizationResource(im));
  for (const o of input.observations)
    add("observation", observationResource(o));
  for (const m of input.medications) add("medication", medicationResource(m));
  for (const e of input.encounters ?? [])
    add("encounter", encounterResource(e));
  for (const f of input.familyHistory ?? [])
    add("familyhistory", familyMemberHistoryResource(f));
  for (const c of input.carePlanItems ?? [])
    add("careplan", carePlanResource(c));
  for (const g of input.careGoals ?? []) add("goal", goalResource(g));
  for (const a of input.appointments ?? [])
    add("appointment", appointmentResource(a));

  return { resourceType: "Bundle", type: "collection", entry };
}

// Serialize the bundle to pretty JSON text (the .json download / zip entry body).
export function fhirBundleJson(input: FhirExportInput): string {
  return JSON.stringify(buildFhirBundle(input), null, 2);
}
