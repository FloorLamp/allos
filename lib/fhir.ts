import { codeFromVaccineCode, type FhirCodeableConcept } from "./cvx-map";
import {
  canonicalBiomarkerForLoinc,
  isVitalLoinc,
  isUnmappedLabLoinc,
} from "./biomarker-loinc";
import { isRealIsoDate } from "./date";
import {
  coursesFromImportedMedication,
  normalizeFhirMedStatus,
  type ImportMedPeriod,
} from "./medication-course-import";
import {
  toAllergyStatus,
  toConditionStatus,
  isNoKnownAllergyText,
  allergyExternalId,
  conditionExternalId,
  medicationExternalId,
  procedureExternalId,
  familyHistoryExternalId,
  carePlanExternalId,
  careGoalExternalId,
} from "./clinical-parse";
import type {
  ImportedImmunization,
  ImportedRecord,
  ImportedAllergy,
  ImportedCondition,
  ImportedEncounter,
  ImportedProcedure,
  ImportedFamilyHistory,
  ImportedCarePlanItem,
  ImportedCareGoal,
  ImportedProvider,
  ImportDemographics,
  ImportResult,
} from "./health-import";
import { tallyUnmappedLoincs } from "./import-report";
import type {
  ImportDrop,
  CoverageEntry,
  ImportReport,
  DropKind,
  DropReason,
} from "./import-report";

// FHIR R4 resource mapping, shared by every FHIR-shaped importer: SMART Health
// Cards (a signed FHIR bundle — lib/smart-health-card) and raw FHIR R4 bundles
// (Epic SMART-on-FHIR / Apple Health "Export FHIR" — parseFhirBundle below).
// Pure: no DB, no network. New resource types are covered by registering another
// mapper in RESOURCE_MAPPERS — nothing else changes. The `idPrefix` scopes the
// external_id dedup key of readings whose identity is only value-derived
// (Observation/Immunization) to the provenance (e.g. "smart-health-card" vs
// "fhir"), so the same reading imported from two sources stays distinct. The
// clinical-list resources (Condition/AllergyIntolerance/medication) instead reuse
// the SHARED `ccda:`-prefixed external_id builders from lib/clinical-parse so the
// SAME problem/allergy carried in both a CCD and a FHIR bundle collapses to a
// single row (cross-format dedup), and reprocessing stays idempotent. Conditions
// and allergies dedup reliably (both key on a code the two formats code the same,
// matching the CDA pickCode preference). Medications cross-dedup only when both
// formats carry a comparable date (FHIR now prefers the effective/therapy date to
// align with the CDA effectiveTime); a MedicationRequest that carries only an
// order-written `authoredOn` can't match a CDA effectiveTime, so — like encounters
// — that case may produce two rows rather than one.
//
// Bundle references (`Observation.performer` → a Practitioner/Organization entry,
// `MedicationRequest.medicationReference` → a Medication) are resolved within the
// bundle: buildResolver indexes every entry by `resourceType/id`, `fullUrl`, and
// bare id, and a `#id` reference is resolved against the resource's own `contained`
// list. Provider provenance (performers, encounter participants/locations) is
// captured onto the ImportedX shape it belongs to and resolved into the shared
// providers registry by the persist layer — exactly like the CDA `<performer>`.

export class FhirError extends Error {}

// Keep the first 10 chars when they form a real calendar date (FHIR dates may be
// "2021-01-15", "2021-01-15T..", or a partial "2021" — partials are dropped).
export function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.slice(0, 10);
  return isRealIsoDate(d) ? d : null;
}

// ---- coding / CodeableConcept helpers ----

type Coding = { system?: string; code?: string; display?: string };

// FHIR coding-system URI → the human label the CDA path already uses, so a code's
// system reads identically whichever format carried it. Unknown systems fall back
// to the raw URI.
const SYSTEM_LABELS: [RegExp, string][] = [
  [/snomed/i, "SNOMED CT"],
  [/icd-10/i, "ICD-10-CM"],
  [/icd-9/i, "ICD-9-CM"],
  [/rxnorm/i, "RxNorm"],
  [/loinc/i, "LOINC"],
];
const ICD10 = /icd-10/i;
const RXNORM = /rxnorm/i;

function systemLabel(system: string | undefined | null): string | null {
  if (!system) return null;
  for (const [re, label] of SYSTEM_LABELS) if (re.test(system)) return label;
  return system;
}

function conceptCodings(cc: any): Coding[] {
  return Array.isArray(cc?.coding) ? cc.coding : [];
}

// A CodeableConcept → its display string (text, else the first coding's display).
function conceptName(cc: any): string | null {
  if (typeof cc?.text === "string" && cc.text.trim()) return cc.text.trim();
  const disp = conceptCodings(cc).find(
    (c) => typeof c.display === "string" && c.display.trim()
  )?.display;
  return disp?.trim() || null;
}

// The first coding's `code` off a CodeableConcept (used for status concepts, whose
// coding.code is the authoritative token, and the encounter class).
function firstCodingCode(cc: any): string | null {
  const c = conceptCodings(cc)[0];
  return c?.code != null ? String(c.code) : null;
}

// Pick a (code, system-label) pair off a CodeableConcept, preferring the given
// systems in order (e.g. billing ICD-10 for a problem, RxNorm for a drug), else the
// first coding that carries a code. Mirrors the CDA pickCode preference so the
// external_id derived from it matches across formats when both carry the same code.
function pickCoding(
  cc: any,
  prefer: RegExp[] = []
): { code: string | null; system: string | null } {
  const codings = conceptCodings(cc).filter((c) => c.code != null);
  if (codings.length === 0) return { code: null, system: null };
  for (const re of prefer) {
    const hit = codings.find((c) => re.test(c.system ?? ""));
    if (hit) return { code: String(hit.code), system: systemLabel(hit.system) };
  }
  const first = codings[0];
  return { code: String(first.code), system: systemLabel(first.system) };
}

// A FHIR HumanName → a single display string ("Given Family", or `text`).
function humanName(r: any): string | null {
  const n = Array.isArray(r?.name) ? r.name[0] : r?.name;
  if (!n) return null;
  if (typeof n.text === "string" && n.text.trim()) return n.text.trim();
  const given = Array.isArray(n.given)
    ? n.given.filter((g: unknown) => typeof g === "string").join(" ")
    : typeof n.given === "string"
      ? n.given
      : "";
  const family = typeof n.family === "string" ? n.family : "";
  const full = `${given} ${family}`.replace(/\s+/g, " ").trim();
  return full || null;
}

// ---- bundle reference resolution ----

export interface FhirEntry {
  fullUrl?: string;
  resource: any;
}

interface FhirBundleCtx {
  idPrefix: string;
  // Resolve a FHIR reference (a `{ reference }` object or bare string) against the
  // bundle. `contained` scopes `#id` references to a resource's own contained list.
  resolve: (ref: any, contained?: any[]) => any | null;
}

function refString(ref: any): string | null {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref.reference === "string") return ref.reference;
  return null;
}

// Index every bundle entry by its resolvable keys — `resourceType/id`, the entry
// `fullUrl` (urn:uuid / absolute URL), and the bare id — so a `reference` string in
// any of those forms resolves to the target resource. `#id` refs are resolved
// against the referencing resource's `contained` list instead.
function buildResolver(
  entries: FhirEntry[]
): (ref: any, contained?: any[]) => any | null {
  const index = new Map<string, any>();
  for (const e of entries) {
    const res = e?.resource;
    if (!res) continue;
    if (e.fullUrl) index.set(e.fullUrl, res);
    const rt = res.resourceType;
    const id = res.id;
    if (rt && id != null) index.set(`${rt}/${id}`, res);
    if (id != null && !index.has(String(id))) index.set(String(id), res);
  }
  return (ref, contained) => {
    const r = refString(ref);
    if (!r) return null;
    if (r.startsWith("#")) {
      const id = r.slice(1);
      return (
        (Array.isArray(contained) ? contained : []).find((c) => c?.id === id) ??
        null
      );
    }
    if (index.has(r)) return index.get(r);
    // "http://host/Practitioner/123" or "Practitioner/123": try the exact
    // `ResourceType/id` pair first.
    const parts = r.split("/");
    if (parts.length >= 2) {
      const pair = parts.slice(-2).join("/");
      if (index.has(pair)) return index.get(pair);
    }
    // Bare-id fallback. When the reference names a resourceType (`Medication/X`),
    // only match a resource OF that type — so a dangling `Medication/X` can't
    // resolve to some unrelated resource that merely shares the bare id `X`
    // (a cross-type collision that would, e.g., turn a lab into a prescription).
    const candidate = index.get(parts[parts.length - 1]) ?? null;
    if (!candidate) return null;
    if (parts.length >= 2) {
      const wantType = parts[parts.length - 2];
      return candidate.resourceType === wantType ? candidate : null;
    }
    return candidate;
  };
}

// ---- provider provenance ----

function fhirIdentifiers(res: any): any[] {
  return Array.isArray(res?.identifier) ? res.identifier : [];
}

// The US National Provider Identifier off a resource's identifier list (system
// http://hl7.org/fhir/sid/us-npi), authoritative for the global provider dedup.
function fhirNpi(res: any): string | null {
  for (const id of fhirIdentifiers(res)) {
    if (/us-npi/i.test(String(id?.system ?? "")) && id?.value != null) {
      const v = String(id.value).trim();
      if (v) return v;
    }
  }
  return null;
}

// Any non-NPI identifier as a secondary stable id, authority-qualified as
// `<system>:<value>` (mirrors the CDA `<root>:<ext>` scheme) so the same local id
// under different assigning authorities stays distinct.
function fhirOtherIdentifier(res: any): string | null {
  for (const id of fhirIdentifiers(res)) {
    const sys = String(id?.system ?? "");
    if (/us-npi/i.test(sys)) continue;
    const val = String(id?.value ?? "").trim();
    if (!val) continue;
    return sys ? `${sys}:${val}` : val;
  }
  return null;
}

function fhirPhone(res: any): string | null {
  for (const t of Array.isArray(res?.telecom) ? res.telecom : []) {
    if ((t?.system === "phone" || t?.system == null) && t?.value != null) {
      const v = String(t.value).trim();
      if (v) return v;
    }
  }
  return null;
}

function addressLine(a: any): string | null {
  if (!a) return null;
  const parts = [
    ...(Array.isArray(a.line) ? a.line : a.line != null ? [a.line] : []),
    a.city,
    a.state,
    a.postalCode,
  ]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  const line = parts.join(", ").replace(/\s+/g, " ").trim();
  return line || null;
}

function fhirAddress(res: any): string | null {
  const addr = res?.address;
  return addressLine(Array.isArray(addr) ? addr[0] : addr);
}

// A Practitioner / Organization / Location / PractitionerRole resource →
// ImportedProvider. PractitionerRole prefers its referenced Practitioner, falling
// back to its Organization. Returns null when no usable name is present.
function providerFromResource(
  res: any,
  resolve: FhirBundleCtx["resolve"]
): ImportedProvider | null {
  if (!res) return null;
  const rt = res.resourceType;
  if (rt === "PractitionerRole") {
    const prac = providerFromResource(
      resolve(res.practitioner, res.contained),
      resolve
    );
    if (prac) return prac;
    return providerFromResource(
      resolve(res.organization, res.contained),
      resolve
    );
  }
  if (rt === "Organization" || rt === "Location") {
    const name = typeof res.name === "string" ? res.name.trim() : "";
    if (!name) return null;
    const npi = fhirNpi(res);
    return {
      name,
      type: "organization",
      // An entity's NPI typically identifies a person, not the org, so an org keeps
      // only a non-NPI identifier for dedup (mirrors the CDA org rule).
      npi: null,
      identifier: npi ? null : fhirOtherIdentifier(res),
      phone: fhirPhone(res),
      address: fhirAddress(res),
    };
  }
  if (rt === "Practitioner") {
    const name = humanName(res);
    if (!name) return null;
    return {
      name,
      type: "individual",
      npi: fhirNpi(res),
      identifier: fhirOtherIdentifier(res),
      phone: fhirPhone(res),
      address: fhirAddress(res),
    };
  }
  return null;
}

// Resolve a list of performer/participant references to one provider, preferring
// the requested face (labs/immunizations prefer the ORGANIZATION the user
// recognizes; encounters prefer the attending INDIVIDUAL). Falls back to a
// Reference that carries only a `display` string.
function providerFromRefs(
  refs: any,
  ctx: FhirBundleCtx,
  contained: any[] | undefined,
  prefer: "organization" | "individual"
): ImportedProvider | null {
  const list = Array.isArray(refs) ? refs : refs != null ? [refs] : [];
  const resolved: ImportedProvider[] = [];
  for (const ref of list) {
    const p = providerFromResource(ctx.resolve(ref, contained), ctx.resolve);
    if (p) resolved.push(p);
  }
  if (resolved.length) {
    return resolved.find((p) => p.type === prefer) ?? resolved[0];
  }
  for (const ref of list) {
    const display = typeof ref?.display === "string" ? ref.display.trim() : "";
    if (display) {
      return {
        name: display,
        type: prefer,
        npi: null,
        identifier: null,
        phone: null,
        address: null,
      };
    }
  }
  return null;
}

// ---- Immunization ----

function doseLabel(resource: any): string | null {
  const dn = resource?.protocolApplied?.[0]?.doseNumberPositiveInt;
  if (typeof dn === "number") return `Dose ${dn}`;
  const ds = resource?.protocolApplied?.[0]?.doseNumberString;
  return typeof ds === "string" && ds.trim() ? ds.trim() : null;
}

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
  // provenance (issue #178), preferring the recognizable organization.
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

// The productive value off an Observation OR one of its component[] entries —
// valueQuantity / valueString / valueCodeableConcept, in that order. Returns null
// when the node carries no value at all, so the caller can DROP a valueless reading
// (mirroring the CDA path's `value == null` guard) instead of importing an empty
// "—" row.
interface FhirObsValue {
  value: string | null;
  value_num: number | null;
  unit: string | null;
}
function readFhirObservationValue(node: any): FhirObsValue | null {
  if (node?.valueQuantity && typeof node.valueQuantity.value === "number") {
    const value_num = node.valueQuantity.value;
    return {
      value: String(value_num),
      value_num,
      unit: node.valueQuantity.unit ?? node.valueQuantity.code ?? null,
    };
  }
  if (typeof node?.valueString === "string") {
    return { value: node.valueString, value_num: null, unit: null };
  }
  if (node?.valueCodeableConcept) {
    const value =
      node.valueCodeableConcept.text ||
      node.valueCodeableConcept.coding?.find((c: any) => c.display)?.display ||
      null;
    if (value != null) return { value, value_num: null, unit: null };
  }
  return null;
}

// Build one ImportedRecord from a code + resolved value + the parent's date /
// provenance. Shared by the scalar Observation path and each component reading, so
// a BP component (LOINC 8480-6 / 8462-4) canonicalizes and routes to `vitals`
// exactly like a top-level vital.
function fhirReadingFromCode(
  code: FhirCodeableConcept | undefined,
  val: FhirObsValue,
  date: string,
  idPrefix: string,
  provider: ImportedProvider | null
): ImportedRecord {
  const name =
    code?.text ||
    code?.coding?.find((c) => c.display)?.display ||
    "Observation";
  const loinc = code?.coding?.find((c) =>
    (c.system ?? "").includes("loinc")
  )?.code;
  // Classify vitals vs labs by LOINC (a FHIR Observation has no section to read),
  // so vital signs land under the vitals category — and don't get registered into
  // the AI biomarker vocabulary — exactly as the CDA path routes them.
  const category = isVitalLoinc(loinc) ? "vitals" : "lab";
  return {
    category,
    name,
    canonical: canonicalBiomarkerForLoinc(loinc) ?? name,
    value: val.value,
    value_num: val.value_num,
    unit: val.unit,
    date,
    loinc: loinc ?? null,
    // Include the value so two distinct same-day readings of the same measure
    // (e.g. two blood pressures) don't collapse to one external_id; a true
    // duplicate (same value) still dedupes.
    external_id: `${idPrefix}:${category === "vitals" ? "vital" : "obs"}:${(
      loinc || name
    ).toLowerCase()}:${date}:${val.value_num ?? val.value ?? ""}`,
    provider,
  };
}

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
  // The performing lab/org (Observation.performer) — provenance (issue #178).
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
function isEnteredInError(res: any): boolean {
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
const NKA_CODES = new Set([
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

// A medication's effective/therapy period(s), for course derivation (#209 Phase
// 2): the effectivePeriod (start/end), an effectiveDateTime point, and any
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
// (statusReason) or, failing that, why it was prescribed (reasonCode) — #209
// Phase 2. statusReason is a SINGLE CodeableConcept on MedicationRequest but an
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
  // Derived courses (#209 Phase 2): effective period(s) → dates, status →
  // open/closed + stop_reason. entered-in-error already returned null above; the
  // pure derivation returns null for it too (belt and suspenders).
  const periods = fhirMedPeriods(r);
  const courses = coursesFromImportedMedication(
    periods.length ? periods : [{ low: date, high: null }],
    normalizeFhirMedStatus(r?.status),
    { note: fhirMedStatusNote(r), fallbackStopDate: date }
  );
  if (courses === null) return null;
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
  };
}

// ---- Encounter ----

// The HL7 v3 ActEncounterCode class (AMB / IMP / EMER / …). R4 carries it as a bare
// Coding on `class`; R5 as a CodeableConcept[].
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
function recordsFromDiagnosticReport(
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

// ---- import DEBUGGER: drop-reason + coverage (issue #208 Phase 2) ----
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
// providers registry as performers / participants / locations (#178,
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

  // Import DEBUGGER accumulators (issue #208 Phase 2).
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
      .map((rec) => ({ loinc: rec.loinc, name: rec.name }))
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
