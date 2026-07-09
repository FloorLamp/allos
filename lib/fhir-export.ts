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

export interface FhirExportProfile {
  name: string | null;
  sex: "male" | "female" | null;
  birthdate: string | null; // YYYY-MM-DD
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

export interface FhirExportInput {
  profile?: FhirExportProfile | null;
  conditions: FhirExportCondition[];
  allergies: FhirExportAllergy[];
  procedures: FhirExportProcedure[];
  immunizations: FhirExportImmunization[];
  observations: FhirExportObservation[];
  medications: FhirExportMedication[];
}

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

  return { resourceType: "Bundle", type: "collection", entry };
}

// Serialize the bundle to pretty JSON text (the .json download / zip entry body).
export function fhirBundleJson(input: FhirExportInput): string {
  return JSON.stringify(buildFhirBundle(input), null, 2);
}
