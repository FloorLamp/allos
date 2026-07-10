import { canonicalBiomarkerForLoinc } from "../biomarker-loinc";
import {
  allergyExternalId,
  careGoalExternalId,
  carePlanExternalId,
  conditionExternalId,
  familyHistoryExternalId,
  isNoKnownAllergy,
  isNoKnownProblemText,
  medicationExternalId,
  procedureExternalId,
  toAllergyStatus,
  toConditionStatus,
} from "../clinical-parse";
import { codeFromVaccineCode } from "../cvx-map";
import type {
  ImportedAllergy,
  ImportedCareGoal,
  ImportedCarePlanItem,
  ImportedCondition,
  ImportedEncounter,
  ImportedFamilyHistory,
  ImportedImmunization,
  ImportedProcedure,
  ImportedProvider,
  ImportedRecord,
} from "../health-import";
import type { ImportMedStatus } from "../medication-course-import";
import {
  coursesFromImportedMedication,
  normalizeCcdaMedStatus,
} from "../medication-course-import";
import {
  normalizeSmokingStatus,
  normalizeSocialSex,
  smokingConditionExternalId,
} from "../social-history";
import type { Sex } from "../types";
import {
  ACT_CODE_OID,
  AGE_OBS_TEMPLATE,
  ALLERGY_OBS_TEMPLATE,
  CARE_PLAN_ELEMENTS,
  COMMENT_ACT_TEMPLATE,
  FAMILY_OBS_TEMPLATE,
  FAMILY_RELATION_LABELS,
  PROBLEM_OBS_TEMPLATE,
  SECTIONS,
  SEVERITY_OBS_TEMPLATE,
  SEX_AT_BIRTH_LOINC,
  SEX_LOINC,
  SMOKING_STATUS_LOINC,
} from "./constants";
import type { CdaSection, SectionExtractor } from "./constants";
import {
  addressOf,
  asArray,
  buildNarrativeIdMap,
  clinicalStatusFromEntryRelationships,
  codeSystemLabel,
  codedDisplayName,
  codedValueOf,
  collectAssignedEntities,
  collectText,
  effTime,
  hl7Date,
  hl7Period,
  loincDisplayName,
  loincFromCode,
  otherIdentifier,
  pickCode,
  providerFromAssignedEntity,
  providerFromPerformer,
  readValue,
  resolveNarrativeText,
  sectionIs,
  telecomOf,
  textOf,
  truthyNegation,
  unitFromEntryRelationships,
  vaccineCodeFrom,
} from "./normalize";

export function mapImmunization(sa: any): ImportedImmunization | null {
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

// Map a lab / vital-sign <observation> to an ImportedRecord of `category`.
// `narrativeIds` is the section's <text> id→text index (built once per section),
// so an observation whose printed name lives only in the narrative table — reached
// via <text><reference value="#id"/> — resolves instead of falling back to
// "Result".
export function mapObservation(
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
export function narrativeDrugName(
  node: any,
  narrativeIds: Record<string, string>
): string | null {
  const resolved = resolveNarrativeText(node, narrativeIds);
  if (!resolved) return null;
  const firstLine = resolved.split(/[\r\n]/)[0].trim();
  return firstLine.length > 0 && firstLine.length <= 150 ? firstLine : null;
}

export function mapMedication(
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

// Map one Problem Concern Act (template 4.3) to an ImportedCondition, or null when
// it carries no productive problem (nullFlavored / "no active problems").
export function mapCondition(
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
export function mapAllergy(
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
export function chiefComplaintsFromSections(sections: CdaSection[]): string[] {
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

// The patient's sex as coded in a document's Social History section, or null. Sex
// assigned at birth (76689-9) is preferred over the administrative Sex (46098-0)
// when both carry a usable value — it's the biologically-relevant signal for the
// sex-banded biomarker ranges — with either falling back to the other. Used only to
// ENRICH the header demographics (mapDemographics) when the header states no sex; it
// never overrides one, and profile seeding stays only-when-unset downstream.
export function socialHistorySex(sections: CdaSection[]): Sex | null {
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
