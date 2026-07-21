import { canonicalBiomarkerForLoinc, isVitalLoinc } from "../biomarker-loinc";
import type { FhirCodeableConcept } from "../cvx-map";
import { isRealIsoDate } from "../date";
import { nuccLabel } from "../nucc-taxonomy";
import type { ImportedProvider, ImportedRecord } from "../health-import";
import { VITAL_CANONICAL, normalizeImportedTemperature } from "../vitals-input";

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

export const ICD10 = /icd-10/i;

export const RXNORM = /rxnorm/i;

function systemLabel(system: string | undefined | null): string | null {
  if (!system) return null;
  for (const [re, label] of SYSTEM_LABELS) if (re.test(system)) return label;
  return system;
}

function conceptCodings(cc: any): Coding[] {
  return Array.isArray(cc?.coding) ? cc.coding : [];
}

// A CodeableConcept → its display string (text, else the first coding's display).
export function conceptName(cc: any): string | null {
  if (typeof cc?.text === "string" && cc.text.trim()) return cc.text.trim();
  const disp = conceptCodings(cc).find(
    (c) => typeof c.display === "string" && c.display.trim()
  )?.display;
  return disp?.trim() || null;
}

// The first coding's `code` off a CodeableConcept (used for status concepts, whose
// coding.code is the authoritative token, and the encounter class).
export function firstCodingCode(cc: any): string | null {
  const c = conceptCodings(cc)[0];
  return c?.code != null ? String(c.code) : null;
}

// Pick a (code, system-label) pair off a CodeableConcept, preferring the given
// systems in order (e.g. billing ICD-10 for a problem, RxNorm for a drug), else the
// first coding that carries a code. Mirrors the CDA pickCode preference so the
// external_id derived from it matches across formats when both carry the same code.
export function pickCoding(
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
export function humanName(r: any): string | null {
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

export interface FhirBundleCtx {
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
export function buildResolver(
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

// The NUCC provider-taxonomy specialty off a FHIR CodeableConcept[] (issue #1056):
// { code, display } from the coding whose system is the NUCC taxonomy URI, else null.
// Used for PractitionerRole.specialty and Practitioner.qualification[].code.
function fhirSpecialty(
  concepts: any
): { code: string; display: string | null } | null {
  const list = Array.isArray(concepts)
    ? concepts
    : concepts != null
      ? [concepts]
      : [];
  for (const cc of list) {
    for (const coding of Array.isArray(cc?.coding) ? cc.coding : []) {
      const sys = String(coding?.system ?? "");
      if (!/nucc\.org\/provider-taxonomy/i.test(sys)) continue;
      const code = String(coding?.code ?? "").trim();
      if (!code) continue;
      const display = String(coding?.display ?? cc?.text ?? "").trim() || null;
      return { code, display };
    }
  }
  return null;
}

// Attach a captured specialty onto a provider candidate (mutates + returns it), when
// the candidate exists and the source carried a NUCC code.
function withSpecialty(
  p: ImportedProvider | null,
  spec: { code: string; display: string | null } | null
): ImportedProvider | null {
  if (!p || !spec) return p;
  return {
    ...p,
    specialtyCode: spec.code,
    specialty: nuccLabel(spec.code, spec.display),
  };
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
    // PractitionerRole.specialty (issue #1056) describes the clinician in THIS role;
    // attach it to whichever face resolves.
    const roleSpec = fhirSpecialty(res.specialty);
    const prac = providerFromResource(
      resolve(res.practitioner, res.contained),
      resolve
    );
    if (prac) return withSpecialty(prac, roleSpec);
    return withSpecialty(
      providerFromResource(resolve(res.organization, res.contained), resolve),
      roleSpec
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
    // Practitioner.qualification[].code carries the specialty when no wrapping
    // PractitionerRole did (issue #1056).
    const spec = fhirSpecialty(
      (Array.isArray(res.qualification) ? res.qualification : [])
        .map((q: any) => q?.code)
        .filter(Boolean)
    );
    return {
      name,
      type: "individual",
      npi: fhirNpi(res),
      identifier: fhirOtherIdentifier(res),
      phone: fhirPhone(res),
      address: fhirAddress(res),
      specialtyCode: spec?.code ?? null,
      specialty: spec ? nuccLabel(spec.code, spec.display) : null,
    };
  }
  return null;
}

// Resolve a list of performer/participant references to one provider, preferring
// the requested face (labs/immunizations prefer the ORGANIZATION the user
// recognizes; encounters prefer the attending INDIVIDUAL). Falls back to a
// Reference that carries only a `display` string.
export function providerFromRefs(
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

export function doseLabel(resource: any): string | null {
  const dn = resource?.protocolApplied?.[0]?.doseNumberPositiveInt;
  if (typeof dn === "number") return `Dose ${dn}`;
  const ds = resource?.protocolApplied?.[0]?.doseNumberString;
  return typeof ds === "string" && ds.trim() ? ds.trim() : null;
}

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

export function readFhirObservationValue(node: any): FhirObsValue | null {
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

// The LOINC code carried on a FHIR CodeableConcept (the coding whose system is
// LOINC), or undefined. Shared so the reading builder and the drop classifier read
// an Observation's LOINC the same way.
export function loincFromFhirCode(
  code: FhirCodeableConcept | undefined
): string | undefined {
  return code?.coding?.find((c) => (c.system ?? "").includes("loinc"))?.code;
}

// Build one ImportedRecord from a code + resolved value + the parent's date /
// provenance. Shared by the scalar Observation path and each component reading, so
// a BP component (LOINC 8480-6 / 8462-4) canonicalizes and routes to `vitals`
// exactly like a top-level vital.
export function fhirReadingFromCode(
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
  const loinc = loincFromFhirCode(code);
  // Classify vitals vs labs by LOINC (a FHIR Observation has no section to read),
  // so vital signs land under the vitals category — and don't get registered into
  // the AI biomarker vocabulary — exactly as the CDA path routes them.
  const category = isVitalLoinc(loinc) ? "vitals" : "lab";
  const canonical = canonicalBiomarkerForLoinc(loinc) ?? name;
  // Body Temperature converts to canonical °F at the import boundary (#1018) —
  // the same conversion the CDA mapper and every live-entry writer perform, so an
  // Epic/Apple FHIR "38.5 Cel" joins the series as 101.3 degF. Recognized
  // spellings only; unrecognized/implausible stays verbatim (never guess). The
  // external_id keeps the AS-SHIPPED value so a reading's dedup identity is
  // stable across normalization changes.
  let stored: FhirObsValue = val;
  if (canonical === VITAL_CANONICAL.temperature.canonical) {
    stored = normalizeImportedTemperature(val.value_num, val.unit) ?? val;
  }
  return {
    category,
    name,
    canonical,
    value: stored.value,
    value_num: stored.value_num,
    unit: stored.unit,
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
