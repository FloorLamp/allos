import { XMLParser } from "fast-xml-parser";
import { isRealIsoDate } from "./date";
import { codeFromVaccineCode } from "./cvx-map";
import {
  canonicalBiomarkerForLoinc,
  isUnmappedLabLoinc,
} from "./biomarker-loinc";
import { readZip, isZip } from "./zip";
import {
  toAllergyStatus,
  toConditionStatus,
  isNoKnownAllergy,
  isNoKnownProblemText,
  allergyExternalId,
  conditionExternalId,
  medicationExternalId,
  procedureExternalId,
  familyHistoryExternalId,
  carePlanExternalId,
  careGoalExternalId,
} from "./clinical-parse";
import { dedupeProviders } from "./providers";
import {
  coursesFromImportedMedication,
  normalizeCcdaMedStatus,
  type ImportMedStatus,
} from "./medication-course-import";
import {
  normalizeSocialSex,
  normalizeSmokingStatus,
  smokingConditionExternalId,
  type CodedValue,
} from "./social-history";
import type { Sex } from "./types";
import type {
  ImportedImmunization,
  ImportedProvider,
  ImportedRecord,
  ImportedAllergy,
  ImportedCondition,
  ImportedEncounter,
  ImportedProcedure,
  ImportedFamilyHistory,
  ImportedCarePlanItem,
  ImportedCareGoal,
  ImportResult,
  ImportDemographics,
} from "./health-import";
import { tallyUnmappedLoincs } from "./import-report";
import type {
  ImportDrop,
  CoverageEntry,
  ImportReport,
  DropKind,
} from "./import-report";

// Parse a C-CDA / CCD document (the DOC0001.XML inside a MyChart "Download
// Summary" XDM package) — the *complete* record. The document is split into its
// sections once, then a set of pluggable **section extractors** map the sections
// they understand into imported records. Immunizations, lab results, vital signs
// and medications ship as built-in extractors; new sections (problems, allergies,
// procedures…) are added by writing another `SectionExtractor` and appending it —
// no change to the walker or the writer. `parseCcdaDocument` exposes the raw
// sections so a consumer can also traverse anything not yet covered. Pure +
// unit-tested (no DB/network).

export class CdaError extends Error {}

// ---- section catalog (LOINC section codes + C-CDA templateIds) ----

export const SECTIONS = {
  immunizations: {
    loinc: "11369-6",
    templates: [
      "2.16.840.1.113883.10.20.22.2.2",
      "2.16.840.1.113883.10.20.22.2.2.1",
    ],
  },
  results: {
    loinc: "30954-2",
    templates: [
      "2.16.840.1.113883.10.20.22.2.3",
      "2.16.840.1.113883.10.20.22.2.3.1",
    ],
  },
  vitals: {
    loinc: "8716-3",
    templates: [
      "2.16.840.1.113883.10.20.22.2.4",
      "2.16.840.1.113883.10.20.22.2.4.1",
    ],
  },
  medications: {
    loinc: "10160-0",
    templates: [
      "2.16.840.1.113883.10.20.22.2.1",
      "2.16.840.1.113883.10.20.22.2.1.1",
    ],
  },
  // Care Teams (issue #178): a provider source, not a clinical reading. The
  // section lists the patient's named clinicians/organizations, which we register
  // into the shared providers registry.
  careTeams: {
    loinc: "85847-2",
    templates: ["2.16.840.1.113883.10.20.22.2.500"],
  },
  allergies: {
    loinc: "48765-2",
    templates: [
      "2.16.840.1.113883.10.20.22.2.6",
      "2.16.840.1.113883.10.20.22.2.6.1",
    ],
  },
  problems: {
    loinc: "11450-4",
    templates: [
      "2.16.840.1.113883.10.20.22.2.5",
      "2.16.840.1.113883.10.20.22.2.5.1",
    ],
  },
  // Encounters / visit history (issue #178 Phase B). The "History of
  // Hospitalizations + Outpatient visits" section; each entry is an Encounter
  // Activity (templateId 4.49) carrying the visit's date/period, type/class,
  // performing clinician, location, and (nested) visit diagnoses.
  encounters: {
    loinc: "46240-8",
    templates: [
      "2.16.840.1.113883.10.20.22.2.22",
      "2.16.840.1.113883.10.20.22.2.22.1",
    ],
  },
  // Reason for Visit (chief complaint 8661-1). Not a stored record on its own —
  // read at the document level and correlated onto the encounter (#178 Phase B).
  reasonForVisit: {
    loinc: "29299-5",
    templates: ["2.16.840.1.113883.10.20.22.2.12"],
  },
  // Social History (issue #188). Carries the patient's coded sex (Sex assigned at
  // birth / Sex) — used to enrich the header demographics — and the tobacco smoking
  // status, captured as a social-history condition. Observations are keyed by their
  // LOINC <code> (72166-2 / 76689-9 / 46098-0), NOT by templateId: the Sex 46098-0
  // observation also carries the 4.38 templateId (historically "Tobacco Use"), so
  // keying smoking off 4.38 would misclassify it — the LOINC is authoritative.
  socialHistory: {
    loinc: "29762-2",
    templates: ["2.16.840.1.113883.10.20.22.2.17"],
  },
  // Procedures / surgical history (LOINC 47519-4). Each entry is a Procedure
  // Activity (procedure 4.14, act 4.12, or observation 4.13) carrying the coded
  // procedure, its effectiveTime, and a performer.
  procedures: {
    loinc: "47519-4",
    templates: [
      "2.16.840.1.113883.10.20.22.2.7",
      "2.16.840.1.113883.10.20.22.2.7.1",
    ],
  },
  // Family History (LOINC 10157-6). Each entry is a Family History Organizer (4.45)
  // for one relative, whose subject codes the relationship and whose nested Family
  // History Observations (4.46) carry that relative's conditions.
  familyHistory: {
    loinc: "10157-6",
    templates: ["2.16.840.1.113883.10.20.22.2.15"],
  },
  // Plan of Treatment / Care Plan (LOINC 18776-5). Each entry is a planned act /
  // encounter / observation / substanceAdministration / procedure (an INT/RQO/PRMS/…
  // mood) carrying the coded planned activity, its intended effectiveTime, and an
  // ordering performer. The older HITSP "Plan of Care" template is 2.10; the C-CDA
  // Plan of Treatment section is 2.10.1.
  carePlan: {
    loinc: "18776-5",
    templates: [
      "2.16.840.1.113883.10.20.22.2.10",
      "2.16.840.1.113883.10.20.22.2.10.1",
    ],
  },
  // Goals (LOINC 61146-7). Each entry is a Goal Observation (4.121) carrying the
  // goal statement (code / value), its target effectiveTime, and a status.
  goals: {
    loinc: "61146-7",
    templates: ["2.16.840.1.113883.10.20.22.2.60"],
  },
} as const;

const LOINC_OID = "2.16.840.1.113883.6.1";
// Code-system OIDs used to label a condition/substance code (#180 / #179).
const SNOMED_OID = "2.16.840.1.113883.6.96";
const ICD10CM_OID = "2.16.840.1.113883.6.90";
const ICD9CM_OID = "2.16.840.1.113883.6.103";
const ICD10PCS_OID = "2.16.840.1.113883.6.4";
const RXNORM_OID = "2.16.840.1.113883.6.88";
// CPT-4 (procedure codes) and HCPCS — common on Procedures-section codes.
const CPT_OID = "2.16.840.1.113883.6.12";
const HCPCS_OID = "2.16.840.1.113883.6.285";
// C-CDA templateIds for the entry-level acts/observations these extractors walk.
const PROBLEM_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.4";
const ALLERGY_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.7";
const SEVERITY_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.8";
const STATUS_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.6";
// HL7 ActEncounterCode (v3 ActCode) — the encounter class translation (AMB / IMP /
// EMER / …) that rides alongside a CPT/local type code on an Encounter (#178 B).
const ACT_CODE_OID = "2.16.840.1.113883.5.4";
// Procedure Activity entry templates (procedure / act / observation flavors) —
// the three shapes a Procedures-section entry can carry.
const PROCEDURE_ACT_TEMPLATES = [
  "2.16.840.1.113883.10.20.22.4.14", // Procedure Activity Procedure
  "2.16.840.1.113883.10.20.22.4.12", // Procedure Activity Act
  "2.16.840.1.113883.10.20.22.4.13", // Procedure Activity Observation
];
// Family History Observation (a relative's condition) + the Age Observation nested
// under it (the relative's age at onset). The organizer's subject/relatedSubject
// carries the relationship + deceased status.
const FAMILY_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.46";
const AGE_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.31";
// Goal Observation (a single goal statement in a Goals section).
const GOAL_OBS_TEMPLATE = "2.16.840.1.113883.10.20.22.4.121";

// The US National Provider Identifier assigning authority OID. An <id> with this
// root carries a provider's NPI (authoritative for the global provider dedup).
const NPI_OID = "2.16.840.1.113883.4.6";

// Social History observation LOINCs (#188). The section entries are identified by
// these codes on the observation's <code>, not by templateId (see SECTIONS note).
const SMOKING_STATUS_LOINC = "72166-2"; // Tobacco smoking status (NHIS)
const SEX_AT_BIRTH_LOINC = "76689-9"; // Sex assigned at birth
const SEX_LOINC = "46098-0"; // Sex

// ---- document → sections ----

export interface CdaSection {
  code: string | null; // LOINC section code
  templateIds: string[];
  title: string | null;
  entries: any[]; // raw <entry> objects (parser output)
  raw: any; // the raw <section> object, for anything not surfaced above
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true, // drop cda:/sdtc:/xsi: prefixes so paths are stable
});

const asArray = <T>(x: T | T[] | undefined | null): T[] =>
  x == null ? [] : Array.isArray(x) ? x : [x];

// Detect a CCD/CDA XML string (vs a SMART Health Card / other).
export function looksLikeCda(text: string): boolean {
  return /<ClinicalDocument[\s>]/.test(text.slice(0, 4000));
}

// Does a ZIP buffer actually contain a CCD/CDA document? Every OOXML file (.xlsx,
// .docx, .pptx) is also a ZIP, so a bare "is it a zip" check misroutes those to
// the XDM parser (which then fails, marking the upload failed instead of letting
// AI extraction handle it). Peek inside for a ClinicalDocument XML; a bomb/corrupt
// entry throws in readZip and is treated as "not an XDM package".
export function xdmContainsCda(buf: Buffer): boolean {
  if (!isZip(buf)) return false;
  try {
    return readZip(buf).some(
      (e) => /\.xml$/i.test(e.name) && looksLikeCda(e.data.toString("utf8"))
    );
  } catch {
    return false;
  }
}

// The CDA patient <name> (given(s) + family, or a bare text node) → one string.
function cdaName(patient: any): string | null {
  const nm = Array.isArray(patient?.name) ? patient.name[0] : patient?.name;
  if (!nm) return null;
  if (typeof nm === "string") return nm.trim() || null;
  const parts = (v: unknown) =>
    asArray(v)
      .map((x) => textOf(x))
      .filter((s): s is string => !!s && !!s.trim());
  const full = [...parts(nm.given), ...parts(nm.family)]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return full || textOf(nm)?.trim() || null;
}

// Patient demographics live in the CDA *header* (recordTarget/patientRole/
// patient), not in a body section, so they're read straight off the document —
// birthTime → birthdate, administrativeGenderCode (M/F, HL7 AdministrativeGender)
// → sex, and <name> → the patient name (document provenance). Returns null when
// none is present.
function mapDemographics(cd: any): ImportDemographics | null {
  const patient = asArray(cd?.recordTarget)
    .map((rt: any) => rt?.patientRole?.patient)
    .find(Boolean);
  if (!patient) return null;
  const birthdate = hl7Date(patient?.birthTime?.["@_value"]);
  const g = patient?.administrativeGenderCode?.["@_code"];
  const sex = g === "M" ? "male" : g === "F" ? "female" : null;
  const name = cdaName(patient);
  if (!birthdate && !sex && !name) return null;
  return { sex, birthdate, name };
}

// Parse the CCD into its flat list of sections (the seam other tooling reads)
// plus the header demographics.
export function parseCcdaDocument(xml: string): {
  sections: CdaSection[];
  demographics: ImportDemographics | null;
  // The ClinicalDocument's own effectiveTime (the document date). Used as the
  // fallback date for a medication-list entry that carries no effectiveTime of its
  // own (#Fix 2), so a plain med list still imports rather than dropping.
  documentDate: string | null;
} {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new CdaError("Could not parse the CCD/CDA XML.");
  }
  const cd = doc?.ClinicalDocument;
  if (!cd) throw new CdaError("Not a C-CDA / CCD document.");

  const sections = asArray(cd?.component?.structuredBody?.component)
    .map((c: any) => c?.section)
    .filter(Boolean)
    .map((s: any): CdaSection => ({
      code: s?.code?.["@_code"] ?? null,
      templateIds: asArray(s?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean),
      title:
        typeof s?.title === "string" ? s.title : (s?.title?.["#text"] ?? null),
      entries: asArray(s?.entry),
      raw: s,
    }));
  return {
    sections,
    demographics: mapDemographics(cd),
    documentDate: effTime(cd?.effectiveTime),
  };
}

// ---- shared field helpers ----

// HL7 date/time (YYYYMMDD[hhmmss][±zzzz]) → YYYY-MM-DD, or null.
function hl7Date(v: unknown): string | null {
  if (v == null) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isRealIsoDate(iso) ? iso : null;
}

// effectiveTime may be a single value, an interval { low }, or an array of both
// a period and a frequency (medications). Take the first usable date.
function effTime(t: any): string | null {
  for (const e of asArray(t)) {
    const d = hl7Date(e?.["@_value"] ?? e?.low?.["@_value"]);
    if (d) return d;
  }
  return null;
}

function truthyNegation(v: unknown): boolean {
  return v === "true" || v === true;
}

function textOf(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v["#text"] === "string") return v["#text"];
  return null;
}

// ---- provider / organization extraction (issue #178) ----

// A CDA <name> (given(s) + family, or a bare text node) → one display string.
// Mirrors cdaName but for an assignedPerson rather than the patient.
function assignedPersonName(person: any): string | null {
  const nm = Array.isArray(person?.name) ? person.name[0] : person?.name;
  if (!nm) return null;
  if (typeof nm === "string") return nm.trim() || null;
  const parts = (v: unknown) =>
    asArray(v)
      .map((x) => textOf(x))
      .filter((s): s is string => !!s && !!s.trim());
  const full = [...parts(nm.given), ...parts(nm.family)]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return full || textOf(nm)?.trim() || null;
}

// The NPI carried by an entity's <id root="…4.6" extension="…"/>, else null.
function npiFrom(entity: any): string | null {
  for (const id of asArray(entity?.id)) {
    if (id?.["@_root"] === NPI_OID) {
      const ext = String(id?.["@_extension"] ?? "").trim();
      if (ext) return ext;
    }
  }
  return null;
}

// Any non-NPI <id> as a secondary stable identifier for dedup when no NPI is
// present (an org/EMR id). Skips nullFlavor'd ids. The extension is namespaced by
// its assigning-authority OID (`<root>:<ext>`) so two DIFFERENT providers that
// happen to share a local id extension under different roots (e.g. two clinics
// each with local id "100") don't collide into one global provider row. Falls
// back to the bare extension only when no root is carried.
function otherIdentifier(entity: any): string | null {
  for (const id of asArray(entity?.id)) {
    if (id?.["@_root"] === NPI_OID) continue;
    if (id?.["@_nullFlavor"] != null) continue;
    const ext = String(id?.["@_extension"] ?? "").trim();
    if (!ext) continue;
    const root = String(id?.["@_root"] ?? "").trim();
    return root ? `${root}:${ext}` : ext;
  }
  return null;
}

// The first usable telephone from an entity's <telecom value="tel:+1-…"/>.
function telecomOf(entity: any): string | null {
  for (const t of asArray(entity?.telecom)) {
    const v = String(t?.["@_value"] ?? "").trim();
    if (/^tel:/i.test(v)) return v.replace(/^tel:/i, "").trim() || null;
  }
  return null;
}

// A one-line address from an entity's <addr> (street/city/state/zip). Skips
// nullFlavor'd addresses.
function addressOf(entity: any): string | null {
  const addr = Array.isArray(entity?.addr) ? entity.addr[0] : entity?.addr;
  if (!addr || addr["@_nullFlavor"] != null) return null;
  const parts = [
    ...asArray(addr.streetAddressLine).map((s) => textOf(s)),
    textOf(addr.city),
    textOf(addr.state),
    textOf(addr.postalCode),
  ]
    .map((s) => (s ? s.trim() : ""))
    .filter(Boolean);
  const line = parts.join(", ").replace(/\s+/g, " ").trim();
  return line || null;
}

// The organization name off a <representedOrganization>, else null.
function representedOrgName(entity: any): string | null {
  const org = entity?.representedOrganization;
  const nm = Array.isArray(org?.name) ? org.name[0] : org?.name;
  const s = textOf(nm)?.trim();
  return s || null;
}

// Turn an <assignedEntity> into a provider candidate. `prefer` decides which face
// of a dual entity (an org + a named person, e.g. a lab performer) becomes the
// provider: labs/immunizations prefer the ORGANIZATION the user recognizes
// ("QUEST", the clinic); the Care Teams section prefers the named INDIVIDUAL.
// Returns null when neither an org name nor a person name is present.
function providerFromAssignedEntity(
  entity: any,
  prefer: "organization" | "individual"
): ImportedProvider | null {
  if (!entity) return null;
  const orgName = representedOrgName(entity);
  const personName = assignedPersonName(entity?.assignedPerson);
  const npi = npiFrom(entity);
  const identifier = npi ? null : otherIdentifier(entity);
  const phone = telecomOf(entity);
  const address = addressOf(entity);

  const asOrg = (): ImportedProvider | null =>
    orgName
      ? {
          name: orgName,
          type: "organization",
          // The entity's NPI typically identifies the person, not the org, so an
          // org provider carries only a non-NPI identifier for dedup.
          npi: null,
          identifier: npi ? null : identifier,
          phone,
          address,
        }
      : null;
  const asPerson = (): ImportedProvider | null =>
    personName
      ? {
          name: personName,
          type: "individual",
          npi,
          identifier,
          phone,
          address,
        }
      : null;

  if (prefer === "organization") return asOrg() ?? asPerson();
  return asPerson() ?? asOrg();
}

// The provider off an entry's <performer> (the one carrying an org or person),
// preferring the organization for the clinical-reading extractors.
function providerFromPerformer(
  node: any,
  prefer: "organization" | "individual" = "organization"
): ImportedProvider | null {
  for (const perf of asArray(node?.performer)) {
    const p = providerFromAssignedEntity(perf?.assignedEntity, prefer);
    if (p) return p;
  }
  return null;
}

// Deep-collect every <assignedEntity> under a node (used for the Care Teams
// section, whose entries nest the clinicians under organizer/act/participant
// shapes that vary by EMR). Skips attribute keys; stops recursing into an
// assignedEntity's own children once captured to avoid double-counting.
function collectAssignedEntities(node: any, out: any[]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) collectAssignedEntities(x, out);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@_")) continue;
    if (k === "assignedEntity") {
      for (const ae of asArray(v)) out.push(ae);
    } else {
      collectAssignedEntities(v, out);
    }
  }
}

// ---- section narrative (<text>) resolution ----

// Recursively gather the visible text of a parsed narrative node (string / number
// / element with #text / nested elements + arrays), skipping attributes. Used to
// read the analyte name out of the cell a <reference> points at.
function collectText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean")
    return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("@_")) continue; // attributes aren't visible text
      if (k === "#text") parts.push(String(v));
      else parts.push(collectText(v));
    }
    return parts.join(" ");
  }
  return "";
}

// Walk a section's <text> narrative once and index every element that carries an
// `ID` attribute → its visible text, so an observation's
// <text><reference value="#id"/> can be resolved to the printed analyte name in
// the narrative <table>. (C-CDA narrative uses the uppercase `ID` attribute;
// removeNSPrefix + the @_ prefix make it `@_ID`.)
export function buildNarrativeIdMap(textNode: any): Record<string, string> {
  const map: Record<string, string> = {};
  const walk = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const id = node["@_ID"];
    if (typeof id === "string" && id && map[id] === undefined) {
      const t = collectText(node).replace(/\s+/g, " ").trim();
      if (t) map[id] = t;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("@_")) continue;
      walk(v);
    }
  };
  walk(textNode);
  return map;
}

// Resolve a node that is either inline text or a <reference value="#id"/> into a
// narrative table cell. Prefers inline text; falls back to the referenced cell.
function resolveNarrativeText(
  node: any,
  ids: Record<string, string>
): string | null {
  const direct = textOf(node);
  if (direct && direct.trim()) return direct.trim();
  const refNode = Array.isArray(node?.reference)
    ? node.reference[0]
    : node?.reference;
  const v = refNode?.["@_value"];
  if (typeof v === "string" && v.startsWith("#")) {
    const t = ids[v.slice(1)];
    if (t && t.trim()) return t.trim();
  }
  return null;
}

// ---- LOINC extraction ----

// Is a <code>/<translation> a LOINC coding? Accept the bare OID (authoritative),
// or codeSystemName == "LOINC" case-insensitively as a secondary signal for
// exports that omit/mis-format the OID.
function isLoincCoding(c: any): boolean {
  if (!c) return false;
  if (c["@_codeSystem"] === LOINC_OID) return true;
  const name = c["@_codeSystemName"];
  return typeof name === "string" && name.trim().toUpperCase() === "LOINC";
}

// Pull a LOINC code from a CDA <code>, whether it's the top-level coding or lives
// in a <translation> child (the local/EMR code being on top). Prefer the
// top-level LOINC; otherwise the first LOINC translation.
function loincFromCode(code: any): string | undefined {
  if (!code) return undefined;
  if (isLoincCoding(code) && code["@_code"] != null)
    return String(code["@_code"]);
  for (const tr of asArray(code.translation)) {
    if (isLoincCoding(tr) && tr["@_code"] != null) return String(tr["@_code"]);
  }
  return undefined;
}

// The displayName off whichever coding (top-level or a translation) is LOINC —
// used as a name source before falling back to the canonical/LOINC display.
function loincDisplayName(code: any): string | null {
  if (!code) return null;
  if (isLoincCoding(code) && code["@_displayName"])
    return String(code["@_displayName"]);
  for (const tr of asArray(code.translation)) {
    if (isLoincCoding(tr) && tr["@_displayName"])
      return String(tr["@_displayName"]);
  }
  return null;
}

// ---- extractor framework ----

export interface SectionExtractor {
  key: string; // e.g. 'immunizations', 'medications'
  matches: (section: CdaSection) => boolean;
  // `documentDate` is the ClinicalDocument's effectiveTime — the medications
  // extractor uses it as the fallback date for an undated med-list entry (#Fix 2).
  // Other extractors ignore it.
  extract: (
    section: CdaSection,
    documentDate?: string | null
  ) => Partial<ImportResult>;
}

// Does a section match one of the catalog entries (by LOINC code or templateId)?
function sectionIs(
  section: CdaSection,
  spec: { loinc: string; templates: readonly string[] }
): boolean {
  if (section.code === spec.loinc) return true;
  return spec.templates.some((t) => section.templateIds.includes(t));
}

// Build a CodeableConcept-ish object from a CDA <code> for the CVX matcher.
function vaccineCodeFrom(code: any) {
  const oid = code?.["@_codeSystem"];
  return {
    coding: code?.["@_code"]
      ? [
          {
            system: oid ? `urn:oid:${oid}` : undefined,
            code: String(code["@_code"]),
            display: code?.["@_displayName"],
          },
        ]
      : [],
    text: code?.["@_displayName"],
  };
}

function mapImmunization(sa: any): ImportedImmunization | null {
  if (!sa || truthyNegation(sa["@_negationInd"])) return null;
  const date = effTime(sa.effectiveTime);
  const mat = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
  if (!date || !mat?.code) return null;
  const catalog = codeFromVaccineCode(vaccineCodeFrom(mat.code));
  if (!catalog) return null;
  const lot = textOf(mat?.lotNumberText)?.trim();
  return {
    code: catalog,
    date,
    dose_label: null,
    notes: lot ? `Lot ${lot}` : null,
    external_id: `ccda:${catalog}:${date}`,
    // Who administered the shot / at what facility (CCD <performer>) — kept as
    // provenance (issue #178) rather than dropped.
    provider: providerFromPerformer(sa),
  };
}

// A resolved value string that is empty or a bare placeholder ("—", "-", "N/A",
// …) carries no result. Normalize it to null so the observation is dropped
// rather than surfacing as an empty record the app renders as "—".
const VALUE_PLACEHOLDERS = new Set([
  "",
  "-",
  "–",
  "—",
  "n/a",
  "na",
  "not applicable",
]);
function normalizeValueText(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return VALUE_PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
}

function readValue(value: any): {
  value: string | null;
  value_num: number | null;
  unit: string | null;
} {
  const v = Array.isArray(value) ? value[0] : value;
  if (v == null) return { value: null, value_num: null, unit: null };
  // An explicitly null-flavored value (e.g. <value nullFlavor="NA"/> on a
  // "Comment(s)" service-comment row) has no result — treat it as absent.
  if (v["@_nullFlavor"] != null)
    return { value: null, value_num: null, unit: null };
  if (v["@_value"] != null && v["@_value"] !== "") {
    const num = Number(v["@_value"]);
    if (Number.isFinite(num))
      return { value: String(num), value_num: num, unit: v["@_unit"] ?? null };
  }
  return {
    value: normalizeValueText(v["@_displayName"] ?? textOf(v)),
    value_num: null,
    unit: null,
  };
}

// Epic (and other EMRs) don't always put the unit on the numeric <value> — for
// many results it rides a COMP <entryRelationship> whose inner observation is a
// SNOMED "units" (246514001) code with an ST value, e.g.
//   <entryRelationship typeCode="COMP"><observation>
//     <code code="246514001" displayName="units"/><value>Thousand/uL</value>
//   </observation></entryRelationship>
// Read it as a fallback when the primary value carried no @_unit.
function unitFromEntryRelationships(obs: any): string | null {
  for (const er of asArray(obs?.entryRelationship)) {
    const inner = er?.observation;
    const c = inner?.code;
    if (!c) continue;
    const isUnits =
      c["@_code"] === "246514001" ||
      (typeof c["@_displayName"] === "string" &&
        c["@_displayName"].trim().toLowerCase() === "units");
    if (isUnits) {
      const u = textOf(inner?.value)?.trim();
      if (u) return u;
    }
  }
  return null;
}

// Map a lab / vital-sign <observation> to an ImportedRecord of `category`.
// `narrativeIds` is the section's <text> id→text index (built once per section),
// so an observation whose printed name lives only in the narrative table — reached
// via <text><reference value="#id"/> — resolves instead of falling back to
// "Result".
function mapObservation(
  obs: any,
  category: "lab" | "vitals",
  narrativeIds: Record<string, string> = {},
  // The performing org resolved off the parent organizer, used when the
  // observation itself carries no <performer> (Epic puts it at either level).
  fallbackProvider: ImportedProvider | null = null
): ImportedRecord | null {
  if (!obs || truthyNegation(obs["@_negationInd"])) return null;
  const date = effTime(obs.effectiveTime);
  if (!date) return null;
  const code = obs.code;
  // LOINC may be the top-level coding, a <translation> child, or flagged only by
  // codeSystemName — extract from wherever it lives so distinct analytes get a
  // stable identity and (for known codes) a canonical destination.
  const loinc = loincFromCode(code);
  const canonicalName = canonicalBiomarkerForLoinc(loinc);
  // Name resolution order:
  //   1. structured @_displayName on the code, then
  //   2. the code's <originalText> — for Epic MyChart the analyte name is inline
  //      text here (alongside a child <reference>), e.g.
  //      <originalText>White Blood Cell Count<reference value="#..."/></originalText>;
  //      textOf reads that #text. If originalText is instead a bare <reference>,
  //      resolveNarrativeText follows it into the section narrative table. Then
  //   3. the observation's <text><reference> into the narrative table (+ any
  //      inline obs.text), then
  //   4. the displayName off a LOINC <translation>, then
  //   5. the LOINC canonical name, and only THEN
  //   6. the literal "Result".
  const resolvedName =
    code?.["@_displayName"] ||
    resolveNarrativeText(code?.originalText, narrativeIds) ||
    resolveNarrativeText(obs?.text, narrativeIds) ||
    loincDisplayName(code) ||
    canonicalName ||
    null;
  const name = resolvedName || "Result";
  const { value, value_num, unit: valueUnit } = readValue(obs.value);
  // Unit is on the numeric value when present, else on a COMP "units" component
  // (Epic ships many results this way).
  const unit = valueUnit ?? unitFromEntryRelationships(obs);
  // Drop noise: an observation with no productive value carries nothing to
  // record — whether it's a nameless "Result.Type" marker or a named-but-empty
  // row like Epic's "Comment(s)" (LOINC 8251-1, <value nullFlavor="NA"/>, which
  // the app would otherwise surface as an empty "—"). Qualitative results keep a
  // string value, so "Positive"/"Detected"/etc. survive.
  if (value == null && value_num == null) return null;
  // Resolve to a canonical biomarker name by LOINC when one exists, so the
  // reading groups with the same concept elsewhere in the app; otherwise keep
  // the printed name.
  const canonical = canonicalName ?? String(name);
  return {
    category,
    name: String(name),
    canonical,
    value,
    value_num,
    unit,
    date,
    loinc: loinc ?? null,
    // Include the value in the dedup key: two distinct same-day observations that
    // share a code/name (or fall back to the same "Result" name with no LOINC)
    // would otherwise collapse to one external_id and dedupe() would drop a real
    // reading. A genuine duplicate (same value) still dedupes.
    external_id: `ccda:${category === "vitals" ? "vital" : "obs"}:${String(
      loinc || name
    ).toLowerCase()}:${date}:${value_num ?? value ?? ""}`,
    // The performing lab/org (e.g. "QUEST") — from the observation's own
    // <performer>, else the organizer's (issue #178).
    provider: providerFromPerformer(obs) ?? fallbackProvider,
  };
}

// A medication's effective/therapy period(s), for course derivation (#209 Phase
// 2). A med's effectiveTime is typically an array of an IVL_TS therapy period
// (low/high) plus a PIVL_TS frequency (period/@value) — take the interval bound(s)
// and any point date, and ignore the frequency element (no low/high/@value). A
// substanceAdministration may carry MULTIPLE IVL_TS periods (distinct episodes).
function medEffectivePeriods(
  t: any
): { low: string | null; high: string | null }[] {
  const out: { low: string | null; high: string | null }[] = [];
  for (const e of asArray(t)) {
    const low = hl7Date(e?.low?.["@_value"]);
    const high = hl7Date(e?.high?.["@_value"]);
    if (low || high) {
      out.push({ low, high });
      continue;
    }
    const point = hl7Date(e?.["@_value"]);
    if (point) out.push({ low: point, high: null });
  }
  return out;
}

// The medication's lifecycle status (#209 Phase 2): the substanceAdministration
// statusCode (active/completed/aborted/suspended/held), else a nested C-CDA
// "status of medication" observation's value code/displayName. The nested value
// is only trusted when it normalizes to a real status token, so an indication /
// reason observation ("Hypertension") is never mistaken for a status.
function ccdaMedStatus(sa: any): ImportMedStatus {
  const primary = normalizeCcdaMedStatus(sa?.statusCode?.["@_code"]);
  if (primary !== "unknown") return primary;
  for (const er of asArray(sa?.entryRelationship)) {
    const v = er?.observation?.value;
    const cand = normalizeCcdaMedStatus(v?.["@_code"] ?? v?.["@_displayName"]);
    if (cand !== "unknown") return cand;
  }
  return "unknown";
}

// Map a medication <substanceAdministration> to a `prescription` record. This is
// the interim home #103 (medication support) calls for — the extraction
// pipeline's `prescription` category — until a dedicated medications table lands,
// at which point only this sink changes. The record ALSO carries the derived
// medication COURSES (#209 Phase 2): the effective period(s) → course dates, the
// status → open/closed + stop_reason; the persist layer turns them into
// medication_courses rows. A nullified/entered-in-error med yields null courses,
// dropping the whole medication.
// A medication name resolved from the narrative table via the code's
// <originalText><reference> (#209 Phase 2). The tested Epic shape points the
// reference at a <content ID> holding ONLY the drug name, but a different export
// could point it at a wider cell (a <td>/<tr> that also holds the sig/frequency),
// whose collectText returns a whitespace-collapsed blob. Guard that: take the
// first line and reject an implausibly long result (> 150 chars) so a
// mis-referenced blob never becomes the med name — the med then falls back to its
// other name sources (or is dropped) rather than being mis-named.
function narrativeDrugName(
  node: any,
  narrativeIds: Record<string, string>
): string | null {
  const resolved = resolveNarrativeText(node, narrativeIds);
  if (!resolved) return null;
  const firstLine = resolved.split(/[\r\n]/)[0].trim();
  return firstLine.length > 0 && firstLine.length <= 150 ? firstLine : null;
}

function mapMedication(
  sa: any,
  narrativeIds: Record<string, string> = {},
  documentDate: string | null = null
): ImportedRecord | null {
  if (!sa || truthyNegation(sa["@_negationInd"])) return null;
  const mat = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
  // The drug name: a structured <name>/<code displayName>, else the code's
  // <originalText><reference> into the section narrative table (Epic ships the
  // printed drug name there — e.g. "albuterol … nebulizer solution" — with the
  // structured code carrying only NDC/RxNorm and no displayName), else an inline
  // sa.text. The sa.text <reference> (the sig/directions) is intentionally NOT a
  // name fallback.
  const name =
    textOf(mat?.name) ||
    mat?.code?.["@_displayName"] ||
    narrativeDrugName(mat?.code?.originalText, narrativeIds) ||
    textOf(sa?.text);
  const date = effTime(sa.effectiveTime);
  // A med-list entry commonly carries a name but NO effectiveTime (#Fix 2). Rather
  // than drop the whole medication, fall back to the DOCUMENT date for the record
  // date — the course still opens UNDATED (started_on null) because we only build a
  // period from the med's OWN effectiveTime, never fabricating a start from the doc
  // date. Only a med with neither a name nor any date still drops.
  const recordDate = date ?? documentDate;
  if (!name || !recordDate) return null;
  const rxnorm =
    mat?.code?.["@_codeSystem"] === "2.16.840.1.113883.6.88"
      ? mat?.code?.["@_code"]
      : undefined;
  const dq = sa?.doseQuantity;
  const dose =
    dq?.["@_value"] != null
      ? `${dq["@_value"]}${dq["@_unit"] ? ` ${dq["@_unit"]}` : ""}`
      : null;
  const periods = medEffectivePeriods(sa.effectiveTime);
  const courses = coursesFromImportedMedication(
    periods.length ? periods : [{ low: date, high: null }],
    ccdaMedStatus(sa),
    { fallbackStopDate: date }
  );
  // A nullified / entered-in-error med → drop it entirely.
  if (courses === null) return null;
  return {
    category: "prescription",
    name: String(name),
    canonical: String(name),
    value: dose,
    value_num: null,
    unit: null,
    date: recordDate,
    external_id: medicationExternalId({
      name: String(name),
      code: rxnorm ? String(rxnorm) : null,
      date: recordDate,
    }),
    courses,
  };
}

// ---- allergies + problem-list conditions (#179 / #180) ----

// Human label for a coding's codeSystem OID (falls back to the OID itself).
function codeSystemLabel(oid: string | undefined | null): string | null {
  switch (oid) {
    case SNOMED_OID:
      return "SNOMED CT";
    case ICD10CM_OID:
      return "ICD-10-CM";
    case ICD9CM_OID:
      return "ICD-9-CM";
    case ICD10PCS_OID:
      return "ICD-10-PCS";
    case RXNORM_OID:
      return "RxNorm";
    case CPT_OID:
      return "CPT";
    case HCPCS_OID:
      return "HCPCS";
    case LOINC_OID:
      return "LOINC";
    default:
      return oid ? oid : null;
  }
}

// The display name of a CDA <code>/<value> or one of its translations, resolving a
// narrative <originalText><reference> into the section table when the structured
// displayName is absent (Epic ships the printed problem/substance name there).
function codedDisplayName(
  node: any,
  narrativeIds: Record<string, string>
): string | null {
  if (!node) return null;
  const direct = node["@_displayName"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const orig = resolveNarrativeText(node.originalText, narrativeIds);
  if (orig) return orig;
  for (const tr of asArray(node.translation)) {
    const d = tr?.["@_displayName"];
    if (typeof d === "string" && d.trim()) return d.trim();
  }
  return null;
}

// Pick the best (code, system) pair off a CDA coded node, preferring a billing
// ICD-10-CM translation, then the node's own coding, then any other translation.
function pickCode(node: any): { code: string | null; system: string | null } {
  if (!node) return { code: null, system: null };
  const codings = [node, ...asArray(node.translation)];
  const icd10 = codings.find((c) => c?.["@_codeSystem"] === ICD10CM_OID);
  const chosen =
    icd10 ??
    (node["@_code"] != null && node["@_nullFlavor"] == null ? node : null) ??
    codings.find((c) => c?.["@_code"] != null && c?.["@_nullFlavor"] == null);
  if (!chosen || chosen["@_code"] == null) return { code: null, system: null };
  return {
    code: String(chosen["@_code"]),
    system: codeSystemLabel(chosen["@_codeSystem"]),
  };
}

// The Problem/Concern status: a REFR status observation (template 4.6) carries the
// clinical status ("Active" / "Resolved" / "Inactive"); its value displayName (or
// code) is authoritative. Falls back to the concern act's statusCode.
function clinicalStatusFromEntryRelationships(obs: any): string | null {
  for (const er of asArray(obs?.entryRelationship)) {
    const inner = er?.observation;
    const tids = asArray(inner?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    if (!tids.includes(STATUS_OBS_TEMPLATE)) continue;
    const v = inner?.value;
    const label = v?.["@_displayName"] ?? v?.["@_code"] ?? textOf(inner?.value);
    if (label) return String(label);
  }
  return null;
}

// Map one Problem Concern Act (template 4.3) to an ImportedCondition, or null when
// it carries no productive problem (nullFlavored / "no active problems").
function mapCondition(
  act: any,
  narrativeIds: Record<string, string>
): ImportedCondition | null {
  if (!act) return null;
  const concernStatus = act?.statusCode?.["@_code"] ?? null;
  // The problem observation lives under the concern act's SUBJ entryRelationship.
  const obs = asArray(act?.entryRelationship)
    .map((er: any) => er?.observation)
    .find((o: any) => {
      const tids = asArray(o?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      return tids.includes(PROBLEM_OBS_TEMPLATE) || o?.value != null;
    });
  if (!obs || truthyNegation(obs["@_negationInd"])) return null;
  const value = Array.isArray(obs.value) ? obs.value[0] : obs.value;
  const name =
    codedDisplayName(value, narrativeIds) ||
    resolveNarrativeText(obs?.text, narrativeIds) ||
    codedDisplayName(obs?.code, narrativeIds);
  if (!name || isNoKnownProblemText(name)) return null;
  const { code, system } = pickCode(value);
  const status = toConditionStatus(
    clinicalStatusFromEntryRelationships(obs) ?? concernStatus
  );
  const onset = effTime(obs.effectiveTime);
  // effectiveTime high = resolution date (only meaningful once resolved).
  const highRaw = asArray(obs.effectiveTime)
    .map((t: any) => t?.high?.["@_value"])
    .find(Boolean);
  const resolved = status === "resolved" ? hl7Date(highRaw) : null;
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

// The reaction/manifestation text off an allergy observation's MFST/reaction
// entryRelationship (Reaction Observation): its value displayName or narrative.
function allergyReaction(
  obs: any,
  narrativeIds: Record<string, string>
): string | null {
  for (const er of asArray(obs?.entryRelationship)) {
    const inner = er?.observation;
    if (!inner) continue;
    const tids = asArray(inner?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    // A reaction observation is template 4.9; but Epic also nests manifestations
    // with a MFST typeCode. Take a coded value that isn't the severity/criticality.
    if (tids.includes(SEVERITY_OBS_TEMPLATE)) continue;
    const codeVal = inner?.code?.["@_code"];
    if (codeVal === "82606-5") continue; // criticality, not a reaction
    const name = codedDisplayName(
      Array.isArray(inner.value) ? inner.value[0] : inner.value,
      narrativeIds
    );
    if (name) return name;
  }
  return null;
}

// The severity word off an allergy observation's Severity Observation (4.8).
function allergySeverity(
  obs: any,
  narrativeIds: Record<string, string>
): string | null {
  const walk = (node: any): string | null => {
    for (const er of asArray(node?.entryRelationship)) {
      const inner = er?.observation;
      if (!inner) continue;
      const tids = asArray(inner?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      if (tids.includes(SEVERITY_OBS_TEMPLATE)) {
        const v = Array.isArray(inner.value) ? inner.value[0] : inner.value;
        const name = codedDisplayName(v, narrativeIds);
        if (name) return name;
      }
      const nested = walk(inner);
      if (nested) return nested;
    }
    return null;
  };
  return walk(obs);
}

// Map one Allergy Concern Act (template 4.30) to an ImportedAllergy, or null for a
// "No known allergies" statement (negated assertion / narrative) — no junk row.
function mapAllergy(
  act: any,
  narrativeIds: Record<string, string>,
  sectionNarrative: string | null
): ImportedAllergy | null {
  if (!act) return null;
  const concernStatus = act?.statusCode?.["@_code"] ?? null;
  const obs = asArray(act?.entryRelationship)
    .map((er: any) => er?.observation)
    .find((o: any) => {
      const tids = asArray(o?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      return tids.includes(ALLERGY_OBS_TEMPLATE) || o?.participant != null;
    });
  if (!obs) return null;
  // Substance: participant[CSM]/participantRole/playingEntity/code.
  const playing = asArray(obs?.participant)
    .map((p: any) => p?.participantRole?.playingEntity)
    .find(Boolean);
  const substanceCodeNode = playing?.code;
  const substance =
    codedDisplayName(substanceCodeNode, narrativeIds) ||
    textOf(playing?.name)?.trim() ||
    null;
  const negated = truthyNegation(obs["@_negationInd"]);
  if (
    isNoKnownAllergy({
      negated,
      substanceName: substance,
      narrative: sectionNarrative,
    })
  ) {
    return null;
  }
  if (!substance) return null;
  const { code, system } = pickCode(substanceCodeNode);
  const status = toAllergyStatus(
    clinicalStatusFromEntryRelationships(obs) ?? concernStatus
  );
  const onset = effTime(obs.effectiveTime);
  return {
    substance,
    substance_code: code,
    substance_code_system: system,
    reaction: allergyReaction(obs, narrativeIds),
    severity: allergySeverity(obs, narrativeIds),
    status,
    onset_date: onset,
    external_id: allergyExternalId({
      substance,
      substanceCode: code,
      onsetDate: onset,
    }),
  };
}

// ---- encounters / visits (#178 Phase B) ----

// effectiveTime as a period: low → start date, high → end date. Falls back to a
// bare @_value on the element for start. Both YYYY-MM-DD or null.
function hl7Period(t: any): { start: string | null; end: string | null } {
  const e = Array.isArray(t) ? t[0] : t;
  return {
    start: hl7Date(e?.low?.["@_value"] ?? e?.["@_value"]),
    end: hl7Date(e?.high?.["@_value"]),
  };
}

// The HL7 v3 ActEncounterCode class (AMB / IMP / EMER / …) carried as a
// <translation> on the encounter <code> alongside the CPT/local type code.
function encounterClassCode(code: any): string | null {
  for (const c of [code, ...asArray(code?.translation)]) {
    if (c?.["@_codeSystem"] === ACT_CODE_OID && c?.["@_code"] != null) {
      const v = String(c["@_code"]).trim();
      if (v) return v;
    }
  }
  return null;
}

// The first non-nullFlavor <id> extension on the encounter — the stable identity
// for the dedup key.
function firstEncounterId(enc: any): string | null {
  for (const id of asArray(enc?.id)) {
    if (id?.["@_nullFlavor"] != null) continue;
    const ext = String(id?.["@_extension"] ?? "").trim();
    if (ext) return ext;
  }
  return null;
}

// The visit location/facility from a <participant typeCode="LOC">'s
// participantRole/playingEntity name, resolved to an organization provider (its
// id/telecom/address ride on the participantRole). Null when no location is named.
function encounterLocation(enc: any): ImportedProvider | null {
  for (const part of asArray(enc?.participant)) {
    if (part?.["@_typeCode"] !== "LOC") continue;
    const role = part?.participantRole;
    const name = textOf(role?.playingEntity?.name)?.trim();
    if (!name) continue;
    return {
      name,
      type: "organization",
      npi: null,
      identifier: otherIdentifier(role),
      phone: telecomOf(role),
      address: addressOf(role),
    };
  }
  return null;
}

// The visit diagnoses nested under the encounter — deep-walk for Problem
// Observations (template 4.4) under the encounter's entryRelationships (Epic nests
// them under a diagnosis act). Prefers the printed original text / narrative, then
// a coded displayName. Dedups by name; drops "no active problems" placeholders.
function encounterDiagnoses(enc: any, ids: Record<string, string>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const walk = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const tids = asArray(node?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    if (
      tids.includes(PROBLEM_OBS_TEMPLATE) &&
      !truthyNegation(node["@_negationInd"])
    ) {
      const value = Array.isArray(node.value) ? node.value[0] : node.value;
      const name =
        codedDisplayName(value, ids) ||
        resolveNarrativeText(node?.text, ids) ||
        codedDisplayName(node?.code, ids);
      if (name && !isNoKnownProblemText(name)) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          names.push(name);
        }
      }
      return; // don't recurse into a captured problem obs (avoids status-obs dupes)
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("@_")) continue;
      walk(v);
    }
  };
  walk(enc?.entryRelationship);
  return names;
}

// The C-CDA Comment Activity template — the standard home for a free-text note
// attached to an entry (a visit summary / clinician comment on an encounter).
const COMMENT_ACT_TEMPLATE = "2.16.840.1.113883.10.20.22.4.64";

// The encounter's free-text narrative / visit summary, from a nested Comment
// Activity (template 4.64) under the encounter's entryRelationships. Prefers the
// printed narrative (resolving a #ref into the section text). Dedups and joins
// multiple comments; returns null when none is present. Kept separate from the
// coded diagnoses walk so a comment never leaks into the diagnoses chips.
function encounterNotes(enc: any, ids: Record<string, string>): string | null {
  const notes: string[] = [];
  const seen = new Set<string>();
  const walk = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const tids = asArray(node?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    if (tids.includes(COMMENT_ACT_TEMPLATE)) {
      const text = resolveNarrativeText(node?.text, ids);
      if (text) {
        const key = text.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          notes.push(text);
        }
      }
      return; // captured — don't recurse into the comment's own children
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("@_")) continue;
      walk(v);
    }
  };
  walk(enc?.entryRelationship);
  return notes.length ? notes.join("\n") : null;
}

// Map one <encounter> (an Encounter Activity, template 4.49) to an
// ImportedEncounter, or null when it carries no usable date. Type display resolves
// the CPT/local code's displayName / narrative originalText ("Office Visit"); the
// class is the ActEncounterCode translation (AMB). The performer is the attending
// clinician (prefer the named individual); the location is the facility. Reason is
// filled at the document level (see chiefComplaintsFromSections) when the encounter
// carries none of its own; notes come from a nested Comment Activity.
function mapEncounter(
  enc: any,
  ids: Record<string, string>,
  index = 0
): ImportedEncounter | null {
  if (!enc || truthyNegation(enc["@_negationInd"])) return null;
  const { start, end } = hl7Period(enc?.effectiveTime);
  const date = start ?? effTime(enc?.effectiveTime);
  if (!date) return null;
  const type = codedDisplayName(enc?.code, ids);
  const classCode = encounterClassCode(enc?.code);
  const provider = providerFromPerformer(enc, "individual");
  const location = encounterLocation(enc);
  const diagnoses = encounterDiagnoses(enc, ids);
  const notes = encounterNotes(enc, ids);
  const idExt = firstEncounterId(enc);
  // With a source <id> the key is stable + shared across documents (so the same
  // visit collapses). Without one, fold in the class AND the entry's position in
  // the section so two distinct same-day same-type id-less visits don't collide.
  const external_id = idExt
    ? `ccda:encounter:${idExt}`
    : `ccda:encounter:${date}:${(type ?? "").toLowerCase()}:${(
        classCode ?? ""
      ).toLowerCase()}:#${index}`;
  return {
    date,
    end_date: end,
    type,
    class_code: classCode,
    reason: null,
    diagnoses,
    provider,
    location,
    notes,
    external_id,
  };
}

// Document-level chief complaint(s) from the Reason for Visit section (29299-5,
// chief complaint 8661-1). Not a stored record — correlated onto the encounter in
// extractFromCcda. Prefers the printed originalText/narrative over the SNOMED
// displayName (which reads "O/E - FEVER" rather than the plain "Fever"). Dedups.
function chiefComplaintsFromSections(sections: CdaSection[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    if (!sectionIs(s, SECTIONS.reasonForVisit)) continue;
    const ids = buildNarrativeIdMap(s.raw?.text);
    for (const entry of s.entries) {
      const obs = entry?.observation;
      if (!obs) continue;
      const value = Array.isArray(obs.value) ? obs.value[0] : obs.value;
      const name =
        resolveNarrativeText(value?.originalText, ids) ||
        (typeof value?.["@_displayName"] === "string"
          ? value["@_displayName"].trim()
          : null) ||
        resolveNarrativeText(obs?.text, ids);
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out;
}

// ---- procedures ----

// Map one Procedures-section entry (a Procedure Activity — procedure / act /
// observation flavor) to an ImportedProcedure, or null when it carries no usable
// name. Name prefers the coded displayName / narrative originalText; date is the
// effectiveTime (period low, else a point); the performer is the operating
// clinician. code/code_system are the CPT/SNOMED identity.
function mapProcedure(
  node: any,
  ids: Record<string, string>
): ImportedProcedure | null {
  if (!node || truthyNegation(node["@_negationInd"])) return null;
  const name =
    codedDisplayName(node?.code, ids) || resolveNarrativeText(node?.text, ids);
  if (!name) return null;
  const { code, system } = pickCode(node?.code);
  const { start } = hl7Period(node?.effectiveTime);
  const date = start ?? effTime(node?.effectiveTime);
  const provider = providerFromPerformer(node, "individual");
  return {
    name,
    code,
    code_system: system,
    date,
    provider,
    external_id: procedureExternalId({ name, code, date }),
  };
}

// ---- family history ----

// HL7 v3 FamilyMember role codes → a friendly relative label, used when the coded
// <relatedSubject><code> carries no displayName. Not exhaustive — the raw code is
// the fallback, so an unmapped relation still imports (just less pretty).
const FAMILY_RELATION_LABELS: Record<string, string> = {
  MTH: "Mother",
  FTH: "Father",
  SIS: "Sister",
  BRO: "Brother",
  SIB: "Sibling",
  DAU: "Daughter",
  SON: "Son",
  CHILD: "Child",
  GRMTH: "Grandmother",
  GRFTH: "Grandfather",
  MGRMTH: "Maternal grandmother",
  MGRFTH: "Maternal grandfather",
  PGRMTH: "Paternal grandmother",
  PGRFTH: "Paternal grandfather",
  GRPRN: "Grandparent",
  AUNT: "Aunt",
  UNCLE: "Uncle",
  COUSN: "Cousin",
  NMTH: "Mother",
  NFTH: "Father",
};

// The affected relative for a Family History Organizer: prefer the relatedSubject
// <code>'s displayName, else map its code, else the raw code. Null when absent.
function familyRelation(org: any): string | null {
  const code = org?.subject?.relatedSubject?.code;
  const display = code?.["@_displayName"];
  if (typeof display === "string" && display.trim()) return display.trim();
  const raw = code?.["@_code"];
  if (raw != null) {
    const key = String(raw).trim().toUpperCase();
    return FAMILY_RELATION_LABELS[key] ?? String(raw).trim();
  }
  return null;
}

// The relative's age (whole years) at the condition's onset, from a nested Age
// Observation (template 4.31) whose <value> is a PQ in years. Null when absent or
// not year-valued.
function familyOnsetAge(obs: any): number | null {
  for (const er of asArray(obs?.entryRelationship)) {
    const inner = er?.observation;
    const tids = asArray(inner?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    if (!tids.includes(AGE_OBS_TEMPLATE)) continue;
    const v = Array.isArray(inner?.value) ? inner.value[0] : inner?.value;
    const unit = v?.["@_unit"];
    const num = Number(v?.["@_value"]);
    // Accept year units ('a' / 'yr' / 'year(s)') or an absent unit.
    if (
      Number.isFinite(num) &&
      (unit == null || /^a$|yr|year/i.test(String(unit)))
    )
      return Math.round(num);
  }
  return null;
}

// Whether the relative is recorded as deceased: a nested Death Observation whose
// value codes SNOMED "Dead" (419099009), found anywhere under the organizer (a
// sibling component observation or nested under a condition's entryRelationship).
// Returns 1 when found, else null (unknown — we don't assert "alive").
function familyDeceased(org: any): number | null {
  const walk = (node: any): boolean => {
    if (node == null || typeof node !== "object") return false;
    const v = Array.isArray(node?.value) ? node.value[0] : node?.value;
    if (v?.["@_code"] === "419099009") return true;
    for (const child of [
      ...asArray(node?.component),
      ...asArray(node?.entryRelationship),
      ...asArray(node?.observation),
    ]) {
      if (walk(child?.observation ?? child)) return true;
    }
    return false;
  };
  return walk(org) ? 1 : null;
}

// Map one Family History Organizer (one relative) to zero or more
// ImportedFamilyHistory rows — one per Family History Observation (4.46) it carries
// that names a condition. Relation + deceased are read once off the organizer.
function familyHistoryFromOrganizer(
  org: any,
  ids: Record<string, string>
): ImportedFamilyHistory[] {
  if (!org) return [];
  const relation = familyRelation(org);
  const out: ImportedFamilyHistory[] = [];
  for (const comp of asArray(org?.component)) {
    const obs = comp?.observation;
    if (!obs || truthyNegation(obs["@_negationInd"])) continue;
    const tids = asArray(obs?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    // A Family History Observation is 4.46; also accept a bare valued observation
    // so a slightly-off template still imports its condition.
    if (!tids.includes(FAMILY_OBS_TEMPLATE) && obs?.value == null) continue;
    const value = Array.isArray(obs.value) ? obs.value[0] : obs.value;
    const condition =
      codedDisplayName(value, ids) ||
      resolveNarrativeText(obs?.text, ids) ||
      codedDisplayName(obs?.code, ids);
    if (!condition || isNoKnownProblemText(condition)) continue;
    const { code, system } = pickCode(value);
    out.push({
      relation,
      condition,
      code,
      code_system: system,
      onset_age: familyOnsetAge(obs),
      deceased: familyDeceased(org),
      external_id: familyHistoryExternalId({ relation, condition, code }),
    });
  }
  return out;
}

// ---- care plan / plan of treatment ----

// The planned-activity element carried under a Plan-of-Treatment entry and a
// friendly category label for it. A section entry wraps exactly one of these (the
// mood is planned/ordered — INT/RQO/PRMS/PRP/…); the element type IS the category.
const CARE_PLAN_ELEMENTS: { key: string; category: string }[] = [
  { key: "act", category: "activity" },
  { key: "encounter", category: "encounter" },
  { key: "observation", category: "observation" },
  { key: "substanceAdministration", category: "medication" },
  { key: "supply", category: "supply" },
  { key: "procedure", category: "procedure" },
];

// Map one Plan-of-Treatment / Care-Plan section entry to an ImportedCarePlanItem,
// or null when it carries no usable description. Description prefers the coded
// displayName / narrative; planned date is the effectiveTime (period low else a
// point); status is the statusCode; the performer is the ordering clinician;
// category comes from the planned element type.
function mapCarePlanItem(
  entry: any,
  ids: Record<string, string>
): ImportedCarePlanItem | null {
  if (!entry) return null;
  const picked = CARE_PLAN_ELEMENTS.map((e) => ({
    node: entry[e.key],
    category: e.category,
  })).find((e) => e.node != null);
  if (!picked) return null;
  const node = picked.node;
  if (truthyNegation(node["@_negationInd"])) return null;
  const description =
    codedDisplayName(node?.code, ids) || resolveNarrativeText(node?.text, ids);
  if (!description) return null;
  const { code, system } = pickCode(node?.code);
  const { start } = hl7Period(node?.effectiveTime);
  const plannedDate = start ?? effTime(node?.effectiveTime);
  const status =
    typeof node?.statusCode?.["@_code"] === "string"
      ? String(node.statusCode["@_code"])
      : null;
  const provider = providerFromPerformer(node, "individual");
  return {
    description,
    code,
    code_system: system,
    category: picked.category,
    planned_date: plannedDate,
    status,
    provider,
    external_id: carePlanExternalId({ description, code, plannedDate }),
  };
}

// ---- goals ----

// Map one Goals-section entry (a Goal Observation, template 4.121) to an
// ImportedCareGoal, or null when it carries no usable description. Description
// prefers the coded <value> displayName, else the narrative, else the <code>
// displayName; target date is the effectiveTime; status is the statusCode.
function mapCareGoal(
  obs: any,
  ids: Record<string, string>
): ImportedCareGoal | null {
  if (!obs || truthyNegation(obs["@_negationInd"])) return null;
  const value = Array.isArray(obs.value) ? obs.value[0] : obs.value;
  const description =
    codedDisplayName(value, ids) ||
    resolveNarrativeText(obs?.text, ids) ||
    codedDisplayName(obs?.code, ids) ||
    (typeof value?.["#text"] === "string" ? value["#text"].trim() : null);
  if (!description) return null;
  // Prefer the value's coding (the measured target), else the observation code.
  const { code, system } =
    value != null && value["@_code"] != null
      ? pickCode(value)
      : pickCode(obs?.code);
  const { start } = hl7Period(obs?.effectiveTime);
  const targetDate = start ?? effTime(obs?.effectiveTime);
  const status =
    typeof obs?.statusCode?.["@_code"] === "string"
      ? String(obs.statusCode["@_code"])
      : null;
  return {
    description,
    code,
    code_system: system,
    target_date: targetDate,
    status,
    external_id: careGoalExternalId({ description, code, targetDate }),
  };
}

// ---- social history (#188) ----

// Reduce a CDA coded <value> (the first, if it's an array) to the primitives the
// pure social-history normalizers consume. Resolves the display from the structured
// @_displayName, else a narrative <originalText><reference> into the section table.
function codedValueOf(
  value: any,
  narrativeIds: Record<string, string>
): CodedValue | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v == null) return null;
  const direct = v["@_displayName"];
  const displayName =
    typeof direct === "string" && direct.trim()
      ? direct.trim()
      : resolveNarrativeText(v.originalText, narrativeIds);
  return {
    code: v["@_code"] != null ? String(v["@_code"]) : null,
    codeSystem: v["@_codeSystem"] != null ? String(v["@_codeSystem"]) : null,
    displayName,
    nullFlavor: v["@_nullFlavor"] != null ? String(v["@_nullFlavor"]) : null,
  };
}

// The patient's sex as coded in a document's Social History section, or null. Sex
// assigned at birth (76689-9) is preferred over the administrative Sex (46098-0)
// when both carry a usable value — it's the biologically-relevant signal for the
// sex-banded biomarker ranges — with either falling back to the other. Used only to
// ENRICH the header demographics (mapDemographics) when the header states no sex; it
// never overrides one, and profile seeding stays only-when-unset downstream.
function socialHistorySex(sections: CdaSection[]): Sex | null {
  let atBirth: Sex | null = null;
  let legal: Sex | null = null;
  for (const s of sections) {
    if (!sectionIs(s, SECTIONS.socialHistory)) continue;
    const ids = buildNarrativeIdMap(s.raw?.text);
    for (const entry of s.entries) {
      const obs = entry?.observation;
      if (!obs || truthyNegation(obs["@_negationInd"])) continue;
      const loinc = loincFromCode(obs.code);
      if (loinc !== SEX_AT_BIRTH_LOINC && loinc !== SEX_LOINC) continue;
      const sex = normalizeSocialSex(codedValueOf(obs.value, ids));
      if (!sex) continue;
      if (loinc === SEX_AT_BIRTH_LOINC) atBirth ??= sex;
      else legal ??= sex;
    }
  }
  return atBirth ?? legal;
}

// The tobacco smoking status (72166-2) captured as social-history condition rows —
// one per informative status observation (a "consumption unknown" / nullFlavor'd
// value yields none; see normalizeSmokingStatus). Stored in the conditions table
// (no new surface): name is the coded status display ("Former smoker"), code the
// SNOMED code, status 'active' as a current documented finding. onset_date is left
// null — the observation's effectiveTime is the assessment date, not a true onset.
function smokingConditionsFromSection(
  section: CdaSection
): ImportedCondition[] {
  const ids = buildNarrativeIdMap(section.raw?.text);
  const out: ImportedCondition[] = [];
  for (const entry of section.entries) {
    const obs = entry?.observation;
    if (!obs || truthyNegation(obs["@_negationInd"])) continue;
    const loinc = loincFromCode(obs.code);
    const tids = asArray(obs?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    const isSmoking =
      loinc === SMOKING_STATUS_LOINC ||
      tids.includes("2.16.840.1.113883.10.20.22.4.78");
    if (!isSmoking) continue;
    const cv = codedValueOf(obs.value, ids);
    const status = normalizeSmokingStatus(cv);
    if (!status) continue;
    out.push({
      name: status.display,
      code: status.code,
      code_system: status.code ? codeSystemLabel(cv?.codeSystem) : null,
      status: "active",
      onset_date: null,
      resolved_date: null,
      external_id: smokingConditionExternalId(status),
    });
  }
  return out;
}

// ---- built-in extractors ----

export const immunizationExtractor: SectionExtractor = {
  key: "immunizations",
  matches: (s) => sectionIs(s, SECTIONS.immunizations),
  extract: (s) => ({
    immunizations: s.entries
      .map((e) => mapImmunization(e?.substanceAdministration))
      .filter((x): x is ImportedImmunization => x != null),
  }),
};

function observationsFromEntries(
  entries: any[],
  category: "lab" | "vitals",
  narrativeIds: Record<string, string> = {}
): ImportedRecord[] {
  const out: ImportedRecord[] = [];
  for (const entry of entries) {
    // Usually organizer → component → observation; sometimes a bare observation.
    // The performing org often rides the organizer (once per panel) rather than
    // each observation, so resolve it once and pass it as the fallback.
    const orgProvider = providerFromPerformer(entry?.organizer);
    const nested = asArray(entry?.organizer?.component).map(
      (c: any) => c?.observation
    );
    for (const o of [...nested, ...asArray(entry?.observation)]) {
      const rec = mapObservation(o, category, narrativeIds, orgProvider);
      if (rec) out.push(rec);
    }
  }
  return out;
}

// Collect providers from the Care Teams section (issue #178). Not a clinical
// reading — it names the patient's clinicians/orgs, which are registered into the
// shared registry. Deep-walks the section for assignedEntity nodes (their nesting
// under organizer/act/participant varies by EMR), preferring the named individual.
function providersFromCareTeams(section: CdaSection): ImportedProvider[] {
  const entities: any[] = [];
  for (const entry of section.entries) collectAssignedEntities(entry, entities);
  const out: ImportedProvider[] = [];
  for (const ae of entities) {
    const p = providerFromAssignedEntity(ae, "individual");
    if (p) out.push(p);
  }
  return out;
}

export const labResultsExtractor: SectionExtractor = {
  key: "results",
  matches: (s) => sectionIs(s, SECTIONS.results),
  extract: (s) => ({
    records: observationsFromEntries(
      s.entries,
      "lab",
      buildNarrativeIdMap(s.raw?.text)
    ),
  }),
};

export const vitalSignsExtractor: SectionExtractor = {
  key: "vitals",
  matches: (s) => sectionIs(s, SECTIONS.vitals),
  extract: (s) => ({
    records: observationsFromEntries(
      s.entries,
      "vitals",
      buildNarrativeIdMap(s.raw?.text)
    ),
  }),
};

export const medicationsExtractor: SectionExtractor = {
  key: "medications",
  matches: (s) => sectionIs(s, SECTIONS.medications),
  extract: (s, documentDate) => {
    // The section's <text> id→text index, so a medication whose name lives in the
    // narrative table (referenced from the structured code's originalText) resolves
    // — same pattern as the lab/vital observation extractors.
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(e?.substanceAdministration, narrativeIds, documentDate)
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};

export const careTeamsExtractor: SectionExtractor = {
  key: "careTeams",
  matches: (s) => sectionIs(s, SECTIONS.careTeams),
  extract: (s) => ({ providers: providersFromCareTeams(s) }),
};

export const allergiesExtractor: SectionExtractor = {
  key: "allergies",
  matches: (s) => sectionIs(s, SECTIONS.allergies),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    const sectionNarrative = collectText(s.raw?.text)
      .replace(/\s+/g, " ")
      .trim();
    return {
      allergies: s.entries
        .map((e) => mapAllergy(e?.act, narrativeIds, sectionNarrative))
        .filter((x): x is ImportedAllergy => x != null),
    };
  },
};

export const problemsExtractor: SectionExtractor = {
  key: "problems",
  matches: (s) => sectionIs(s, SECTIONS.problems),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      conditions: s.entries
        .map((e) => mapCondition(e?.act, narrativeIds))
        .filter((x): x is ImportedCondition => x != null),
    };
  },
};

export const encountersExtractor: SectionExtractor = {
  key: "encounters",
  matches: (s) => sectionIs(s, SECTIONS.encounters),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      encounters: s.entries
        .map((e, i) => mapEncounter(e?.encounter, narrativeIds, i))
        .filter((x): x is ImportedEncounter => x != null),
    };
  },
};

export const proceduresExtractor: SectionExtractor = {
  key: "procedures",
  matches: (s) => sectionIs(s, SECTIONS.procedures),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      procedures: s.entries
        // A Procedure Activity entry carries the act under procedure / act /
        // observation depending on the flavor; take whichever is present.
        .map((e) =>
          mapProcedure(e?.procedure ?? e?.act ?? e?.observation, narrativeIds)
        )
        .filter((x): x is ImportedProcedure => x != null),
    };
  },
};

export const familyHistoryExtractor: SectionExtractor = {
  key: "familyHistory",
  matches: (s) => sectionIs(s, SECTIONS.familyHistory),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      familyHistory: s.entries.flatMap((e) =>
        familyHistoryFromOrganizer(e?.organizer, narrativeIds)
      ),
    };
  },
};

export const carePlanExtractor: SectionExtractor = {
  key: "carePlan",
  matches: (s) => sectionIs(s, SECTIONS.carePlan),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      carePlanItems: s.entries
        .map((e) => mapCarePlanItem(e, narrativeIds))
        .filter((x): x is ImportedCarePlanItem => x != null),
    };
  },
};

export const goalsExtractor: SectionExtractor = {
  key: "goals",
  matches: (s) => sectionIs(s, SECTIONS.goals),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      careGoals: s.entries
        .map((e) => mapCareGoal(e?.observation, narrativeIds))
        .filter((x): x is ImportedCareGoal => x != null),
    };
  },
};

// Social History (issue #188): the smoking status becomes a condition row; the
// section's coded sex is read separately (socialHistorySex) to enrich demographics.
export const socialHistoryExtractor: SectionExtractor = {
  key: "socialHistory",
  matches: (s) => sectionIs(s, SECTIONS.socialHistory),
  extract: (s) => ({ conditions: smokingConditionsFromSection(s) }),
};

export const DEFAULT_EXTRACTORS: SectionExtractor[] = [
  immunizationExtractor,
  labResultsExtractor,
  vitalSignsExtractor,
  medicationsExtractor,
  careTeamsExtractor,
  allergiesExtractor,
  problemsExtractor,
  encountersExtractor,
  proceduresExtractor,
  familyHistoryExtractor,
  carePlanExtractor,
  goalsExtractor,
  socialHistoryExtractor,
];

// ---- import DEBUGGER: drop-reason + coverage report (issue #208 Phase 2) ----
//
// The extractors above silently drop candidates: mapObservation returns null for a
// null-flavored "Comment(s)" row, mapImmunization for an unmapped vaccine code,
// mapAllergy for a "no known allergy" negation, and whole sections with no matching
// extractor (Functional Status / Plan of Treatment / Insurance) are skipped by the
// walker. This block RECORDS each drop + why, and which sections were / weren't
// consumed, WITHOUT changing what imports. It re-runs the same leaf mappers (pure,
// cheap) and classifies the ones that came back null, so the mappers themselves stay
// untouched — the report is built at the extractor-framework level.

// A human title for a section: its own <title>, else a known catalog name, else the
// LOINC code. Epic sets titles ("Insurance", "Plan of Treatment"), which is exactly
// what the "present but not consumed" list wants to show.
const KNOWN_SECTION_TITLES: Record<string, string> = {
  [SECTIONS.immunizations.loinc]: "Immunizations",
  [SECTIONS.results.loinc]: "Results",
  [SECTIONS.vitals.loinc]: "Vital Signs",
  [SECTIONS.medications.loinc]: "Medications",
  [SECTIONS.careTeams.loinc]: "Care Teams",
  [SECTIONS.allergies.loinc]: "Allergies",
  [SECTIONS.problems.loinc]: "Problems",
  [SECTIONS.encounters.loinc]: "Encounters",
  [SECTIONS.procedures.loinc]: "Procedures",
  [SECTIONS.familyHistory.loinc]: "Family History",
  [SECTIONS.carePlan.loinc]: "Plan of Treatment",
  [SECTIONS.goals.loinc]: "Goals",
  [SECTIONS.reasonForVisit.loinc]: "Reason for Visit",
  [SECTIONS.socialHistory.loinc]: "Social History",
};

function sectionTitle(section: CdaSection): string {
  const t = section.title?.trim();
  if (t) return t;
  if (section.code && KNOWN_SECTION_TITLES[section.code])
    return KNOWN_SECTION_TITLES[section.code];
  return section.code ? `LOINC ${section.code}` : "Untitled section";
}

// Every observation node under a Results/Vitals section — the SAME traversal
// observationsFromEntries uses (organizer→component→observation, plus a bare
// observation), minus the provider resolution the drop path doesn't need. Kept as a
// generator so the kept-path and the drop-path can't drift on which nodes exist.
function* observationNodesOf(entries: any[]): Generator<any> {
  for (const entry of entries) {
    const nested = asArray(entry?.organizer?.component).map(
      (c: any) => c?.observation
    );
    for (const o of [...nested, ...asArray(entry?.observation)]) {
      if (o != null) yield o;
    }
  }
}

// The printed label of an observation (mirrors mapObservation's name resolution),
// used to name a dropped reading in the report.
function observationLabel(obs: any, ids: Record<string, string>): string {
  const code = obs?.code;
  const loinc = loincFromCode(code);
  return (
    code?.["@_displayName"] ||
    resolveNarrativeText(code?.originalText, ids) ||
    resolveNarrativeText(obs?.text, ids) ||
    loincDisplayName(code) ||
    (loinc ? (canonicalBiomarkerForLoinc(loinc) ?? `LOINC ${loinc}`) : null) ||
    (code?.["@_code"] != null ? `Code ${code["@_code"]}` : null) ||
    "Result"
  );
}

// Classify WHY a lab/vital observation was dropped (called only when mapObservation
// returned null). Order mirrors mapObservation's guards: negation, then no date, then
// the value: an explicit nullFlavor, a placeholder ("—"/"N/A"), or truly no value.
function classifyObservationDrop(
  obs: any,
  category: "lab" | "vitals",
  ids: Record<string, string>,
  section: string
): ImportDrop {
  const kind: DropKind = category === "vitals" ? "vitals" : "lab";
  const label = observationLabel(obs, ids);
  let reason: ImportDrop["reason"] = "other";
  if (truthyNegation(obs?.["@_negationInd"])) reason = "negated";
  else if (!effTime(obs?.effectiveTime)) reason = "other";
  else {
    const v = Array.isArray(obs?.value) ? obs.value[0] : obs?.value;
    if (v?.["@_nullFlavor"] != null) reason = "null_flavor";
    else {
      const { value, value_num } = readValue(obs?.value);
      if (value == null && value_num == null) {
        const rawText = v ? (v["@_displayName"] ?? textOf(v)) : null;
        reason =
          rawText != null && String(rawText).trim() !== ""
            ? "placeholder_noise"
            : "no_value";
      }
    }
  }
  return { kind, label, reason, section };
}

// Classify a dropped immunization: negated, no date, no product, or a vaccine code
// with no catalog mapping (unmapped_loinc covers "a code we can't map").
function classifyImmunizationDrop(sa: any, section: string): ImportDrop {
  const mat = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
  const label =
    textOf(mat?.name) ||
    mat?.code?.["@_displayName"] ||
    (mat?.code?.["@_code"] != null ? `Code ${mat.code["@_code"]}` : null) ||
    "Immunization";
  let reason: ImportDrop["reason"] = "other";
  if (truthyNegation(sa?.["@_negationInd"])) reason = "negated";
  else if (!effTime(sa?.effectiveTime)) reason = "other";
  else if (!mat?.code) reason = "no_value";
  else if (!codeFromVaccineCode(vaccineCodeFrom(mat.code)))
    reason = "unmapped_loinc";
  return { kind: "immunization", label, reason, section };
}

// Classify a dropped medication (kept OUTSIDE mapMedication to avoid touching the
// medication mapper — see the #209 note): negated, else missing name/date.
function classifyMedicationDrop(
  sa: any,
  ids: Record<string, string>,
  section: string
): ImportDrop {
  const mat = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
  const name =
    textOf(mat?.name) ||
    mat?.code?.["@_displayName"] ||
    narrativeDrugName(mat?.code?.originalText, ids) ||
    textOf(sa?.text);
  const label = name || "Medication";
  // With the document-date fallback (#Fix 2) a named med always imports, so a drop
  // here is a negation or a genuinely nameless entry.
  let reason: ImportDrop["reason"] = "other";
  if (truthyNegation(sa?.["@_negationInd"])) reason = "negated";
  else if (!name) reason = "no_value";
  return { kind: "medication", label, reason, section };
}

// Classify a dropped allergy: a "no known allergy" negation, an absent substance, or
// other. Re-reads the concern act the same way mapAllergy does.
function classifyAllergyDrop(
  act: any,
  ids: Record<string, string>,
  sectionNarrative: string | null,
  section: string
): ImportDrop {
  const obs = asArray(act?.entryRelationship)
    .map((er: any) => er?.observation)
    .find((o: any) => {
      const tids = asArray(o?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      return tids.includes(ALLERGY_OBS_TEMPLATE) || o?.participant != null;
    });
  const playing = asArray(obs?.participant)
    .map((p: any) => p?.participantRole?.playingEntity)
    .find(Boolean);
  const substance =
    codedDisplayName(playing?.code, ids) ||
    textOf(playing?.name)?.trim() ||
    null;
  const negated = truthyNegation(obs?.["@_negationInd"]);
  let reason: ImportDrop["reason"] = "other";
  if (
    isNoKnownAllergy({
      negated,
      substanceName: substance,
      narrative: sectionNarrative,
    })
  )
    reason = "negated";
  else if (!substance) reason = "no_value";
  return { kind: "allergy", label: substance ?? "Allergy", reason, section };
}

// Classify a dropped problem-list condition: a "no known problem" placeholder, an
// absent name, or other. Re-reads the concern act like mapCondition.
function classifyConditionDrop(
  act: any,
  ids: Record<string, string>,
  section: string
): ImportDrop {
  const obs = asArray(act?.entryRelationship)
    .map((er: any) => er?.observation)
    .find((o: any) => {
      const tids = asArray(o?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      return tids.includes(PROBLEM_OBS_TEMPLATE) || o?.value != null;
    });
  const value = Array.isArray(obs?.value) ? obs.value[0] : obs?.value;
  const name =
    codedDisplayName(value, ids) ||
    resolveNarrativeText(obs?.text, ids) ||
    codedDisplayName(obs?.code, ids);
  let reason: ImportDrop["reason"] = "other";
  if (truthyNegation(obs?.["@_negationInd"])) reason = "negated";
  else if (name && isNoKnownProblemText(name)) reason = "negated";
  else if (!name) reason = "no_value";
  return { kind: "condition", label: name ?? "Condition", reason, section };
}

// Collect the row-level drops for one section, by extractor key. Only the sections
// whose leaf mappers can return null are scanned; enrichment sections (careTeams,
// socialHistory, reasonForVisit) and encounters aren't itemized here.
function collectSectionDrops(
  section: CdaSection,
  key: string,
  drops: ImportDrop[],
  documentDate: string | null
): void {
  const ids = buildNarrativeIdMap(section.raw?.text);
  const title = sectionTitle(section);
  if (key === "results" || key === "vitals") {
    const cat = key === "vitals" ? "vitals" : "lab";
    for (const o of observationNodesOf(section.entries)) {
      if (mapObservation(o, cat, ids)) continue;
      drops.push(classifyObservationDrop(o, cat, ids, title));
    }
  } else if (key === "immunizations") {
    for (const e of section.entries) {
      const sa = e?.substanceAdministration;
      if (!sa || mapImmunization(sa)) continue;
      drops.push(classifyImmunizationDrop(sa, title));
    }
  } else if (key === "medications") {
    for (const e of section.entries) {
      const sa = e?.substanceAdministration;
      // Re-run the SAME mapper the kept-path uses (same narrative ids + doc-date
      // fallback) so a now-imported undated med isn't miscounted as a drop (#Fix 2).
      if (!sa || mapMedication(sa, ids, documentDate)) continue;
      drops.push(classifyMedicationDrop(sa, ids, title));
    }
  } else if (key === "allergies") {
    const narrative = collectText(section.raw?.text)
      .replace(/\s+/g, " ")
      .trim();
    for (const e of section.entries) {
      const act = e?.act;
      if (!act || mapAllergy(act, ids, narrative)) continue;
      drops.push(classifyAllergyDrop(act, ids, narrative, title));
    }
  } else if (key === "problems") {
    for (const e of section.entries) {
      const act = e?.act;
      if (!act || mapCondition(act, ids)) continue;
      drops.push(classifyConditionDrop(act, ids, title));
    }
  }
}

// Labs that imported but carry a LOINC with no canonical mapping (Fix 3): a
// non-fatal "add these to LOINC_TO_CANONICAL" annotation surfaced in the debugger.
// Vitals (routed by isVitalLoinc) and code-less rows are excluded.
function unmappedLoincsFromRecords(records: ImportedRecord[]) {
  return tallyUnmappedLoincs(
    records
      .filter((r) => isUnmappedLabLoinc(r.loinc))
      .map((r) => ({ loinc: r.loinc, name: r.name }))
  );
}

// Which drop kind a deduped medical_records row belongs to (by its category).
function recordDropKind(category: string): DropKind {
  if (category === "vitals") return "vitals";
  if (category === "prescription") return "medication";
  return "lab";
}

// Drops for the rows dedupe() removes: dedupe() keeps the FIRST occurrence of each
// external_id, so every subsequent same-key row is a `deduped` drop. Mirrors
// dedupe()'s semantics exactly so the report matches what actually happened.
function dedupeDrops<T extends { external_id: string }>(
  rows: T[],
  kindOf: (r: T) => DropKind,
  labelOf: (r: T) => string
): ImportDrop[] {
  const seen = new Set<string>();
  const out: ImportDrop[] = [];
  for (const r of rows) {
    if (seen.has(r.external_id))
      out.push({ kind: kindOf(r), label: labelOf(r), reason: "deduped" });
    else seen.add(r.external_id);
  }
  return out;
}

// Build the coverage list + the section/unrecognized drops for a CCD's sections.
// A section is "consumed" when an extractor matches it OR it's the Reason-for-Visit
// section AND its chief complaint was actually correlated onto the single encounter
// (`reasonForVisitConsumed` — see extractFromCcda). Reason for Visit has no extractor
// of its own, so with zero/multiple encounters (or one that already carries a reason)
// the correlation does NOT fire and the section is genuinely not consumed.
function buildCcdaCoverage(
  sections: CdaSection[],
  extractors: SectionExtractor[],
  reasonForVisitConsumed: boolean,
  documentDate: string | null
): { coverage: CoverageEntry[]; drops: ImportDrop[] } {
  const coverage: CoverageEntry[] = [];
  const drops: ImportDrop[] = [];
  for (const section of sections) {
    const ex = extractors.find((e) => e.matches(section));
    const title = sectionTitle(section);
    const isReasonForVisit = sectionIs(section, SECTIONS.reasonForVisit);
    const consumed = !!ex || (isReasonForVisit && reasonForVisitConsumed);
    const key = ex?.key ?? (isReasonForVisit ? "reasonForVisit" : "");
    coverage.push({
      key: key || title,
      title,
      consumed,
      present: section.entries.length,
    });
    if (!consumed) {
      drops.push({
        kind: "section",
        label: title,
        reason: "unrecognized_section",
        section: title,
      });
      continue;
    }
    if (ex) collectSectionDrops(section, ex.key, drops, documentDate);
  }
  return { coverage, drops };
}

// ---- top-level ----

function dedupe<T extends { external_id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.external_id)) continue;
    seen.add(r.external_id);
    out.push(r);
  }
  return out;
}

// A field is "empty" (and so eligible to be backfilled) when it is null/undefined,
// a blank string, or an empty array.
function isEmptyField(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

// De-duplicate by external_id, keeping the FIRST occurrence but BACKFILLING any of
// its empty fields (null / blank / empty-array) from later duplicates — never
// overwriting a value the kept row already has. This matters for the multi-document
// XDM merge (parseXdm feeds documents largest-first): a comprehensive document's
// copy of a shared row is kept, but that copy can be THINNER than a per-visit
// document's copy — e.g. a comprehensive Encounters section lists a visit with
// reason:null and no nested diagnoses (its extractFromCcda skips reason-correlation
// because it has >1 encounter), while the per-visit document carries both. Field
// backfill recovers the richer data (reason, diagnoses, provider, location, …)
// without overwriting anything, so it's safe to apply across every record kind and
// doesn't disturb the largest-first demographics selection.
function mergeDedupe<T extends { external_id: string }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  const order: string[] = [];
  for (const row of rows) {
    const kept = byId.get(row.external_id);
    if (!kept) {
      byId.set(row.external_id, { ...row });
      order.push(row.external_id);
      continue;
    }
    for (const k of Object.keys(row) as (keyof T)[]) {
      if (isEmptyField(kept[k]) && !isEmptyField(row[k])) kept[k] = row[k];
    }
  }
  return order.map((id) => byId.get(id)!);
}

// Run the given extractors over a CCD. Each section is handed to the first
// extractor that matches it; results are merged and de-duplicated.
export function extractFromCcda(
  xml: string,
  extractors: SectionExtractor[] = DEFAULT_EXTRACTORS
): ImportResult {
  const { sections, demographics, documentDate } = parseCcdaDocument(xml);
  const immunizations: ImportedImmunization[] = [];
  const records: ImportedRecord[] = [];
  const providers: ImportedProvider[] = [];
  const allergies: ImportedAllergy[] = [];
  const conditions: ImportedCondition[] = [];
  const encounters: ImportedEncounter[] = [];
  const procedures: ImportedProcedure[] = [];
  const familyHistory: ImportedFamilyHistory[] = [];
  const carePlanItems: ImportedCarePlanItem[] = [];
  const careGoals: ImportedCareGoal[] = [];
  for (const section of sections) {
    const ex = extractors.find((e) => e.matches(section));
    if (!ex) continue;
    const part = ex.extract(section, documentDate);
    if (part.immunizations) immunizations.push(...part.immunizations);
    if (part.records) records.push(...part.records);
    if (part.providers) providers.push(...part.providers);
    if (part.allergies) allergies.push(...part.allergies);
    if (part.conditions) conditions.push(...part.conditions);
    if (part.encounters) encounters.push(...part.encounters);
    if (part.procedures) procedures.push(...part.procedures);
    if (part.familyHistory) familyHistory.push(...part.familyHistory);
    if (part.carePlanItems) carePlanItems.push(...part.carePlanItems);
    if (part.careGoals) careGoals.push(...part.careGoals);
  }
  // Correlate the document-level Reason for Visit / chief complaint onto the
  // encounter when the encounter carries none of its own. In an Epic per-visit CCD
  // the reason section describes the single encounter in the same document; a
  // document with several encounters can't be attributed reliably, so we skip.
  const deduped = dedupe(encounters);
  // Whether the Reason-for-Visit section was actually consumed (correlated). Only
  // true when there's exactly one reason-less encounter to attach the chief
  // complaint to AND the section carried one — the same condition the coverage
  // report reflects (F2).
  let reasonForVisitConsumed = false;
  if (deduped.length === 1 && !deduped[0].reason) {
    const reasons = chiefComplaintsFromSections(sections);
    if (reasons.length) {
      deduped[0].reason = reasons.join("; ");
      reasonForVisitConsumed = true;
    }
  }
  // Enrich the header demographics with the Social History sex (#188) — the
  // fallback when the header states none. Prefer the header's own sex; never
  // override it. If the header carried no demographics at all but the section
  // codes a sex, surface it as sex-only demographics so profile seeding still
  // learns it (birthdate/name stay null).
  const shSex = socialHistorySex(sections);
  const enrichedDemographics: ImportDemographics | null =
    demographics == null
      ? shSex
        ? { sex: shSex, birthdate: null, name: null }
        : null
      : demographics.sex == null && shSex
        ? { ...demographics, sex: shSex }
        : demographics;

  // Kept sets, deduped. Capture them once so the report's `deduped` drops are the
  // rows dedupe() removed (keep-first) and `imported` is the surviving count.
  const keptImmunizations = dedupe(immunizations).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const keptRecords = dedupe(records).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const keptAllergies = dedupe(allergies).sort((a, b) =>
    a.substance.localeCompare(b.substance)
  );
  const keptConditions = dedupe(conditions).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const keptEncounters = deduped.sort((a, b) => b.date.localeCompare(a.date));
  const keptProcedures = dedupe(procedures).sort((a, b) =>
    (b.date ?? "").localeCompare(a.date ?? "")
  );
  const keptFamilyHistory = dedupe(familyHistory).sort((a, b) =>
    a.condition.localeCompare(b.condition)
  );
  const keptCarePlanItems = dedupe(carePlanItems).sort((a, b) =>
    (a.planned_date ?? "").localeCompare(b.planned_date ?? "")
  );
  const keptCareGoals = dedupe(careGoals).sort((a, b) =>
    (a.target_date ?? "").localeCompare(b.target_date ?? "")
  );

  // Import DEBUGGER report (issue #208 Phase 2): coverage + section drops from the
  // walker, plus the per-kind `deduped` drops and the kept-vs-considered counts.
  const { coverage, drops } = buildCcdaCoverage(
    sections,
    extractors,
    reasonForVisitConsumed,
    documentDate
  );
  drops.push(
    ...dedupeDrops(
      records,
      (r) => recordDropKind(r.category),
      (r) => r.name
    ),
    ...dedupeDrops(
      immunizations,
      () => "immunization",
      (i) => i.code
    ),
    ...dedupeDrops(
      allergies,
      () => "allergy",
      (a) => a.substance
    ),
    ...dedupeDrops(
      conditions,
      () => "condition",
      (c) => c.name
    ),
    ...dedupeDrops(
      encounters,
      () => "encounter",
      (e) => e.type ?? e.date
    ),
    ...dedupeDrops(
      procedures,
      () => "procedure",
      (p) => p.name
    ),
    ...dedupeDrops(
      familyHistory,
      () => "family_history",
      (f) => `${f.relation ?? "Relative"}: ${f.condition}`
    ),
    ...dedupeDrops(
      carePlanItems,
      () => "care_plan",
      (c) => c.description
    ),
    ...dedupeDrops(
      careGoals,
      () => "care_goal",
      (g) => g.description
    )
  );
  const imported =
    keptRecords.length +
    keptImmunizations.length +
    keptAllergies.length +
    keptConditions.length +
    keptEncounters.length +
    keptProcedures.length +
    keptFamilyHistory.length +
    keptCarePlanItems.length +
    keptCareGoals.length;
  const rowDrops = drops.filter(
    (d) => d.reason !== "unrecognized_section"
  ).length;
  const report: ImportReport = {
    drops,
    coverage,
    imported,
    considered: imported + rowDrops,
    unmappedLoincs: unmappedLoincsFromRecords(keptRecords),
  };

  return {
    immunizations: keptImmunizations,
    records: keptRecords,
    allergies: keptAllergies,
    conditions: keptConditions,
    // Newest visit first (also the page's display order).
    encounters: keptEncounters,
    procedures: keptProcedures,
    familyHistory: keptFamilyHistory,
    carePlanItems: keptCarePlanItems,
    careGoals: keptCareGoals,
    demographics: enrichedDemographics,
    // Section-level providers (Care Teams). Per-reading performers ride on the
    // records/immunizations above; import-persist unions all three and dedups
    // globally when resolving them into the shared registry.
    providers,
    report,
  };
}

export function parseCcda(
  xml: string,
  extractors?: SectionExtractor[]
): ImportResult {
  return extractFromCcda(xml, extractors);
}

// Merge several parsed ImportResults (one per ClinicalDocument in an XDM package)
// into one, de-duplicating each record kind by its stable external_id so a section
// carried in two documents (Allergies/Medications/Immunizations/Results appear in
// both DOC0001 and DOC0002) collapses to a single row rather than double-counting,
// with field-level backfill so the richer copy's fields survive (see mergeDedupe).
// Providers dedup by their global key. Demographics come from the FIRST result
// that carries them — callers pass the most-complete (largest) document first.
//
// Dedup is only as good as the content-derived external_id. Two documents that code
// the SAME real reading differently produce different keys and so are NOT collapsed:
// a lab keyed `ccda:obs:${loinc||name}:${date}:${value}` diverges when one document
// carries the LOINC and the other falls back to the printed name, and a medication
// keyed `ccda:rx:${rxnorm||name}:${date}` diverges on a differing start date. (Value
// precision does NOT diverge — numeric values are normalized through Number(), so
// "5.20" and "5.2" share a key.) Fully reconciling divergent coding would need
// semantic matching we deliberately don't attempt (it risks merging distinct
// analytes); the identical-coding case — the norm within one Epic export — collapses
// cleanly, and manual rows are never touched by the importer regardless.
export function mergeImportResults(results: ImportResult[]): ImportResult {
  const immunizations: ImportedImmunization[] = [];
  const records: ImportedRecord[] = [];
  const allergies: ImportedAllergy[] = [];
  const conditions: ImportedCondition[] = [];
  const encounters: ImportedEncounter[] = [];
  const procedures: ImportedProcedure[] = [];
  const familyHistory: ImportedFamilyHistory[] = [];
  const carePlanItems: ImportedCarePlanItem[] = [];
  const careGoals: ImportedCareGoal[] = [];
  const providers: ImportedProvider[] = [];
  let demographics: ImportDemographics | null = null;
  for (const r of results) {
    immunizations.push(...r.immunizations);
    records.push(...r.records);
    allergies.push(...(r.allergies ?? []));
    conditions.push(...(r.conditions ?? []));
    encounters.push(...(r.encounters ?? []));
    procedures.push(...(r.procedures ?? []));
    familyHistory.push(...(r.familyHistory ?? []));
    carePlanItems.push(...(r.carePlanItems ?? []));
    careGoals.push(...(r.careGoals ?? []));
    providers.push(...(r.providers ?? []));
    // Demographics come from the FIRST document that carries any (callers order
    // largest-first). NB: this is a whole-OBJECT pick, not a field-level merge — so
    // if the largest document's header states a sex but a SMALLER document is the
    // only one whose Social History codes a sex (#188), the smaller doc's
    // social-history sex is NOT backfilled here. In practice a MyChart XDM's
    // comprehensive DOC0001 carries both the header and the Social History section,
    // so the largest document already has the richest demographics; this is a
    // pre-existing multi-document edge, and profile sex-seeding stays only-when-unset
    // regardless. Left as-is to avoid overreach.
    if (!demographics && r.demographics) demographics = r.demographics;
  }
  const keptImmunizations = mergeDedupe(immunizations).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const keptRecords = mergeDedupe(records).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const keptAllergies = mergeDedupe(allergies).sort((a, b) =>
    a.substance.localeCompare(b.substance)
  );
  const keptConditions = mergeDedupe(conditions).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const keptEncounters = mergeDedupe(encounters).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
  const keptProcedures = mergeDedupe(procedures).sort((a, b) =>
    (b.date ?? "").localeCompare(a.date ?? "")
  );
  const keptFamilyHistory = mergeDedupe(familyHistory).sort((a, b) =>
    a.condition.localeCompare(b.condition)
  );
  const keptCarePlanItems = mergeDedupe(carePlanItems).sort((a, b) =>
    (a.planned_date ?? "").localeCompare(b.planned_date ?? "")
  );
  const keptCareGoals = mergeDedupe(careGoals).sort((a, b) =>
    (a.target_date ?? "").localeCompare(b.target_date ?? "")
  );

  // Merge the per-document reports (issue #208 Phase 2): coverage + drops concat
  // (the view dedups coverage by title), plus the CROSS-document `deduped` drops —
  // the rows mergeDedupe collapsed because a section (Results/Allergies/…) appears
  // in both DOC0001 and DOC0002. `imported` is the final merged row count.
  const crossDocDrops: ImportDrop[] = [
    ...dedupeDrops(
      records,
      (r) => recordDropKind(r.category),
      (r) => r.name
    ),
    ...dedupeDrops(
      immunizations,
      () => "immunization",
      (i) => i.code
    ),
    ...dedupeDrops(
      allergies,
      () => "allergy",
      (a) => a.substance
    ),
    ...dedupeDrops(
      conditions,
      () => "condition",
      (c) => c.name
    ),
    ...dedupeDrops(
      encounters,
      () => "encounter",
      (e) => e.type ?? e.date
    ),
    ...dedupeDrops(
      procedures,
      () => "procedure",
      (p) => p.name
    ),
    ...dedupeDrops(
      familyHistory,
      () => "family_history",
      (f) => `${f.relation ?? "Relative"}: ${f.condition}`
    ),
    ...dedupeDrops(
      carePlanItems,
      () => "care_plan",
      (c) => c.description
    ),
    ...dedupeDrops(
      careGoals,
      () => "care_goal",
      (g) => g.description
    ),
  ];
  const perDoc = results
    .map((r) => r.report)
    .filter((r): r is ImportReport => r != null);
  const mergedDrops = [...perDoc.flatMap((r) => r.drops), ...crossDocDrops];
  const mergedCoverage = perDoc.flatMap((r) => r.coverage);
  const imported =
    keptRecords.length +
    keptImmunizations.length +
    keptAllergies.length +
    keptConditions.length +
    keptEncounters.length +
    keptProcedures.length +
    keptFamilyHistory.length +
    keptCarePlanItems.length +
    keptCareGoals.length;
  const rowDrops = mergedDrops.filter(
    (d) => d.reason !== "unrecognized_section"
  ).length;
  const report: ImportReport = {
    drops: mergedDrops,
    coverage: mergedCoverage,
    imported,
    considered: imported + rowDrops,
    unmappedLoincs: unmappedLoincsFromRecords(keptRecords),
  };

  return {
    immunizations: keptImmunizations,
    records: keptRecords,
    allergies: keptAllergies,
    conditions: keptConditions,
    encounters: keptEncounters,
    procedures: keptProcedures,
    familyHistory: keptFamilyHistory,
    carePlanItems: keptCarePlanItems,
    careGoals: keptCareGoals,
    demographics,
    providers: dedupeProviders(providers).map((p) => ({
      name: p.name,
      type: p.type,
      npi: p.npi ?? null,
      identifier: p.identifier ?? null,
      phone: p.phone ?? null,
      address: p.address ?? null,
    })),
    report,
  };
}

// Parse EVERY ClinicalDocument .xml in a MyChart XDM (.zip / .xdm) package and
// merge them: a MyChart export ships the complete record (DOC0001.XML) plus one or
// more encounter-specific documents (DOC0002.XML holds the visit's Encounter +
// Reason for Visit sections). Both are parsed and merged; the shared external_id
// dedup collapses the sections they have in common, so the merge never
// double-counts. Documents are ordered largest-first so demographics come from the
// most-complete one. Non-CDA members (METADATA.XML, stylesheets) are skipped.
export function parseXdm(
  buf: Buffer,
  extractors?: SectionExtractor[]
): ImportResult {
  if (!isZip(buf)) throw new CdaError("Not an XDM (.zip) package.");
  const candidates = readZip(buf)
    .filter((e) => /\.xml$/i.test(e.name))
    .map((e) => e.data.toString("utf8"))
    .filter((xml) => looksLikeCda(xml))
    .sort((a, b) => b.length - a.length);
  if (candidates.length === 0)
    throw new CdaError("No CCD/CDA document found in the XDM package.");
  return mergeImportResults(
    candidates.map((xml) => extractFromCcda(xml, extractors))
  );
}
