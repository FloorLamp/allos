import { isRealIsoDate } from "../date";
import type { ImportedProvider } from "../health-import";
import type { CodedValue } from "../social-history";
import { XMLParser } from "fast-xml-parser";
import {
  CPT_OID,
  HCPCS_OID,
  ICD10CM_OID,
  ICD10PCS_OID,
  ICD9CM_OID,
  LOINC_OID,
  NPI_OID,
  RXNORM_OID,
  SNOMED_OID,
  STATUS_OBS_TEMPLATE,
  VALUE_PLACEHOLDERS,
} from "./constants";
import type { CdaSection } from "./constants";

export const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true, // drop cda:/sdtc:/xsi: prefixes so paths are stable
});

export const asArray = <T>(x: T | T[] | undefined | null): T[] =>
  x == null ? [] : Array.isArray(x) ? x : [x];

// HL7 date/time (YYYYMMDD[hhmmss][±zzzz]) → YYYY-MM-DD, or null.
export function hl7Date(v: unknown): string | null {
  if (v == null) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isRealIsoDate(iso) ? iso : null;
}

// effectiveTime may be a single value, an interval { low }, or an array of both
// a period and a frequency (medications). Take the first usable date.
export function effTime(t: any): string | null {
  for (const e of asArray(t)) {
    const d = hl7Date(e?.["@_value"] ?? e?.low?.["@_value"]);
    if (d) return d;
  }
  return null;
}

export function truthyNegation(v: unknown): boolean {
  return v === "true" || v === true;
}

export function textOf(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v["#text"] === "string") return v["#text"];
  return null;
}

// ---- provider / organization extraction ----

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
export function otherIdentifier(entity: any): string | null {
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
export function telecomOf(entity: any): string | null {
  for (const t of asArray(entity?.telecom)) {
    const v = String(t?.["@_value"] ?? "").trim();
    if (/^tel:/i.test(v)) return v.replace(/^tel:/i, "").trim() || null;
  }
  return null;
}

// A one-line address from an entity's <addr> (street/city/state/zip). Skips
// nullFlavor'd addresses.
export function addressOf(entity: any): string | null {
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
export function providerFromAssignedEntity(
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
export function providerFromPerformer(
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
export function collectAssignedEntities(node: any, out: any[]): void {
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
export function collectText(node: any): string {
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
export function resolveNarrativeText(
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
export function loincFromCode(code: any): string | undefined {
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
export function loincDisplayName(code: any): string | null {
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

// Does a section match one of the catalog entries (by LOINC code or templateId)?
export function sectionIs(
  section: CdaSection,
  spec: { loinc: string; templates: readonly string[] }
): boolean {
  if (section.code === spec.loinc) return true;
  return spec.templates.some((t) => section.templateIds.includes(t));
}

// Build a CodeableConcept-ish object from a CDA <code> for the CVX matcher.
export function vaccineCodeFrom(code: any) {
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

function normalizeValueText(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return VALUE_PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
}

export function readValue(value: any): {
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
export function unitFromEntryRelationships(obs: any): string | null {
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

// Human label for a coding's codeSystem OID (falls back to the OID itself).
export function codeSystemLabel(oid: string | undefined | null): string | null {
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
export function codedDisplayName(
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
export function pickCode(node: any): {
  code: string | null;
  system: string | null;
} {
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
export function clinicalStatusFromEntryRelationships(obs: any): string | null {
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

// effectiveTime as a period: low → start date, high → end date. Falls back to a
// bare @_value on the element for start. Both YYYY-MM-DD or null.
export function hl7Period(t: any): {
  start: string | null;
  end: string | null;
} {
  const e = Array.isArray(t) ? t[0] : t;
  return {
    start: hl7Date(e?.low?.["@_value"] ?? e?.["@_value"]),
    end: hl7Date(e?.high?.["@_value"]),
  };
}

// Reduce a CDA coded <value> (the first, if it's an array) to the primitives the
// pure social-history normalizers consume. Resolves the display from the structured
// @_displayName, else a narrative <originalText><reference> into the section table.
export function codedValueOf(
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
