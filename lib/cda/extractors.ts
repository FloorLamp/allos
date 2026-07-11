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
  CLINICAL_NOTE_LOINCS,
  COMMENT_ACT_TEMPLATE,
  FAMILY_OBS_TEMPLATE,
  FAMILY_RELATION_LABELS,
  PROBLEM_OBS_TEMPLATE,
  SECTIONS,
  SEVERITY_OBS_TEMPLATE,
  SEX_AT_BIRTH_LOINC,
  SEX_LOINC,
  SMOKING_STATUS_LOINC,
  VALUE_PLACEHOLDERS,
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
    // provenance rather than dropped.
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
    // <performer>, else the organizer's.
    provider: providerFromPerformer(obs) ?? fallbackProvider,
  };
}

// A medication's effective/therapy period(s), for course derivation.
// A med's effectiveTime is typically an array of an IVL_TS therapy period
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

// The medication's lifecycle status: the substanceAdministration
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
// the interim home (medication support) calls for — the extraction
// pipeline's `prescription` category — until a dedicated medications table lands,
// at which point only this sink changes. The record ALSO carries the derived
// medication COURSES: the effective period(s) → course dates, the
// status → open/closed + stop_reason; the persist layer turns them into
// medication_courses rows. A nullified/entered-in-error med yields null courses,
// dropping the whole medication.
// A medication name resolved from the narrative table via the code's
// <originalText><reference>. The tested Epic shape points the
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

// `opts` (#266) tunes the two inpatient medication-section flavors without
// touching the ambulatory med-list behavior:
//   - `snapshot`: the section documents what ALREADY HAPPENED (Administered
//     Medications — meds given during the stay), not an ongoing regimen. An
//     active/unstated lifecycle status is capped to `completed` so a one-off
//     administration never opens an open (current) course, and an undated entry's
//     course is anchored to the document date instead of staying open-undated.
//   - `courseNote`: a short provenance note put on the derived course(s) (e.g.
//     "At hospital discharge"), so the course's origin survives into the app.
export function mapMedication(
  sa: any,
  narrativeIds: Record<string, string> = {},
  documentDate: string | null = null,
  opts: { snapshot?: boolean; courseNote?: string | null } = {}
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
  let status = ccdaMedStatus(sa);
  // Snapshot sections (#266): an administration already happened — cap an
  // active/unstated status to `completed` so it can never open a current course.
  if (opts.snapshot && (status === "active" || status === "unknown"))
    status = "completed";
  const courses = coursesFromImportedMedication(
    // A snapshot entry with no date of its own is anchored to the document date
    // (the encounter is when it happened); a regular med-list entry keeps the
    // open-undated behavior (#Fix 2 — never fabricate a start from the doc date).
    periods.length
      ? periods
      : [{ low: date ?? (opts.snapshot ? documentDate : null), high: null }],
    status,
    {
      fallbackStopDate: opts.snapshot ? (date ?? documentDate) : date,
      note: opts.courseNote ?? null,
    }
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

// ---- allergies + problem-list conditions ----

// Map one Problem Concern Act (template 4.3) to an ImportedCondition, or null when
// it carries no productive problem (nullFlavored / "no active problems").
//
// `sectionDefaultStatus` (#265): a History of Past Illness / Resolved Problems
// section passes "resolved" — the SECTION asserts the problem is past, so the
// concern act's tracking statusCode (often still "active" while the resolved
// problem is tracked) is ignored, while an explicit clinical-status observation
// (template 4.6) on the problem stays authoritative. The Problems section passes
// nothing and keeps the existing clinical-status ?? concern-status resolution.
export function mapCondition(
  act: any,
  narrativeIds: Record<string, string>,
  sectionDefaultStatus?: ImportedCondition["status"]
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
  const clinicalStatus = clinicalStatusFromEntryRelationships(obs);
  const status =
    sectionDefaultStatus != null
      ? clinicalStatus != null
        ? toConditionStatus(clinicalStatus)
        : sectionDefaultStatus
      : toConditionStatus(clinicalStatus ?? concernStatus);
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

// ---- encounters / visits ----

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

// Reduce a section's <text> narrative to a single clean line, dropping bare
// placeholders. Used as the fallback content source for a section whose clinical
// meaning lives ONLY in the printed narrative (no structured entries) — e.g. the
// narrative-only Reason for Visit some hospital systems emit (issue #267).
export function sectionNarrativeText(sectionRaw: any): string | null {
  const t = collectText(sectionRaw?.text).replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (VALUE_PLACEHOLDERS.has(t.toLowerCase())) return null;
  return t;
}

// Document-level chief complaint(s) from the Reason for Visit section (29299-5,
// chief complaint 8661-1). Not a stored record — correlated onto the encounter in
// extractFromCcda. Prefers the printed originalText/narrative over the SNOMED
// displayName (which reads "O/E - FEVER" rather than the plain "Fever"). Dedups.
// When a section carries NO usable structured complaint (a narrative-only Reason
// for Visit — a ~50-word <text> blob with zero entries, seen on some hospital
// systems, issue #267), falls back to the stripped section narrative so the reason
// still imports rather than being dropped.
export function chiefComplaintsFromSections(sections: CdaSection[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | null): void => {
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const s of sections) {
    if (!sectionIs(s, SECTIONS.reasonForVisit)) continue;
    const ids = buildNarrativeIdMap(s.raw?.text);
    let fromEntries = 0;
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
      fromEntries++;
      add(name);
    }
    // Narrative-only fallback: only when the section produced no structured
    // complaint (so an entry-bearing section never double-counts its narrative).
    if (fromEntries === 0) add(sectionNarrativeText(s.raw));
  }
  return out;
}

// The document's encompassing visit (componentOf/encompassingEncounter): the single
// real encounter a hospital/visit document is ABOUT. Its stable source id (matched to
// an Encounter Activity's external_id) and period let the reason-for-visit
// correlation pick the right encounter when a document ships several Encounter
// Activities (the visit plus a companion event-type activity — issue #267).
export interface EncompassingEncounterInfo {
  externalId: string | null; // "ccda:encounter:<id>" — comparable to an ImportedEncounter
  start: string | null;
  end: string | null;
}

export function encompassingEncounterInfo(
  cd: any
): EncompassingEncounterInfo | null {
  const ee = Array.isArray(cd?.componentOf)
    ? cd.componentOf[0]?.encompassingEncounter
    : cd?.componentOf?.encompassingEncounter;
  if (!ee) return null;
  const idExt = firstEncounterId(ee);
  const { start, end } = hl7Period(ee?.effectiveTime);
  return {
    externalId: idExt ? `ccda:encounter:${idExt}` : null,
    start: start ?? effTime(ee?.effectiveTime),
    end,
  };
}

// Choose which encounter the document-level Reason for Visit should attach to, or -1
// when it can't be attributed reliably (issue #267). Only reason-less encounters are
// eligible (a reason of their own is never overwritten). One eligible encounter → it.
// Several → prefer the document's encompassing visit, matched by stable source id
// first (strongest), else by matching start date; ambiguity (no encompassing hint, or
// several encounters sharing the encompassing period) yields -1 rather than guessing.
export function selectReasonTarget(
  encounters: ImportedEncounter[],
  encompassing: EncompassingEncounterInfo | null
): number {
  const eligible = encounters
    .map((e, i) => ({ e, i }))
    .filter((x) => !x.e.reason);
  if (eligible.length === 0) return -1;
  if (eligible.length === 1) return eligible[0].i;
  if (encompassing) {
    if (encompassing.externalId) {
      const byId = eligible.filter(
        (x) => x.e.external_id === encompassing.externalId
      );
      if (byId.length === 1) return byId[0].i;
    }
    if (encompassing.start) {
      const byDate = eligible.filter((x) => x.e.date === encompassing.start);
      if (byDate.length === 1) return byDate[0].i;
    }
  }
  return -1;
}

// ---- standalone visit diagnoses (top-level "Diagnosis" section, 29308-4) ----

// One visit diagnosis collected from a top-level Standalone Visit Diagnoses section
// — the packaging Epic uses when the diagnoses are NOT nested in an Encounter
// Activity. Carries the coded identity + onset so an uncorrelatable one can land as a
// full problem-list condition.
export interface StandaloneVisitDiagnosis {
  name: string;
  code: string | null;
  code_system: string | null;
  onset_date: string | null;
}

// Deep-walk the top-level Standalone Visit Diagnoses section(s) for their Problem
// Observations (template 4.4) — the SAME node shape encounterDiagnoses reads when the
// diagnoses are nested in an encounter, but here kept with the coded identity + date
// so an uncorrelatable one can become a condition. Prefers the printed original text /
// narrative, then a coded displayName; dedups by name; drops "no active problems"
// placeholders. Read at the document level (like chiefComplaintsFromSections) so the
// caller can correlate it onto the same-document encounter.
//
// Admitting Diagnoses sections (#266) route through the SAME walk: their Hospital
// Admission Diagnosis acts wrap the same Problem Observations (4.4), and an
// admitting diagnosis is a visit diagnosis of the same-document (inpatient)
// encounter — so it correlates/lands identically, and one diagnosis packaged both
// ways dedups by name here.
export function visitDiagnosesFromSections(
  sections: CdaSection[]
): StandaloneVisitDiagnosis[] {
  const out: StandaloneVisitDiagnosis[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    if (
      !sectionIs(s, SECTIONS.visitDiagnoses) &&
      !sectionIs(s, SECTIONS.admissionDiagnoses)
    )
      continue;
    const ids = buildNarrativeIdMap(s.raw?.text);
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
            const { code, system } = pickCode(value);
            out.push({
              name,
              code,
              code_system: system,
              onset_date: effTime(node.effectiveTime),
            });
          }
        }
        return; // captured — don't recurse into a captured problem obs
      }
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("@_")) continue;
        walk(v);
      }
    };
    walk(s.entries);
  }
  return out;
}

// ---- clinician / progress notes (top-level narrative note sections) ----

// A free-text clinical note collected from a top-level Progress Notes (11506-3) or
// per-clinician "Notes from <clinician>" section. `text` is the plain-text note body
// (React-escaped on render, no raw HTML — the #71 precedent). `author` is the
// authoring clinician when the section names one (attribution). `title` is the
// section title (e.g. "Progress Notes", "Notes from …"), used to label a standalone
// note. `date` is the section's author time when present.
export interface ClinicalNote {
  text: string;
  author: ImportedProvider | null;
  title: string | null;
  date: string | null;
}

// Whether a section is a clinical-note section: its <code> LOINC is one of the known
// clinical-note codes, OR its title mentions "note(s)" (the deployment-varying "Notes
// from <clinician>" case). The title fallback never fires for a section whose code is
// the Visit Diagnoses LOINC (which routes to its own handler even if titled "… Notes").
export function isClinicalNoteSection(section: CdaSection): boolean {
  const code = section.code ?? undefined;
  if (code && CLINICAL_NOTE_LOINCS.has(code)) return true;
  // A diagnoses section routes to its own document-level handler even if titled
  // "… Notes" — never let the title heuristic double-process it as a note.
  if (
    code === SECTIONS.visitDiagnoses.loinc ||
    sectionIs(section, SECTIONS.admissionDiagnoses)
  )
    return false;
  const title = section.title?.trim().toLowerCase();
  return !!title && /\bnotes?\b/.test(title);
}

// Collect the free-text notes from every top-level Progress Notes / per-clinician
// Notes section — the note body is the section narrative (collectText, whitespace-
// normalized, plain text). Skips a section with no narrative. Read at the document
// level so the caller can attach the note to the same-document encounter (else store
// it as a standalone dated note). One entry per note section.
export function clinicalNotesFromSections(
  sections: CdaSection[]
): ClinicalNote[] {
  const out: ClinicalNote[] = [];
  for (const s of sections) {
    if (!isClinicalNoteSection(s)) continue;
    const text = collectText(s.raw?.text).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const authorNode = asArray(s.raw?.author)[0];
    out.push({
      text,
      author: providerFromAssignedEntity(
        authorNode?.assignedAuthor,
        "individual"
      ),
      title: s.title?.trim() || null,
      date: hl7Date(authorNode?.time?.["@_value"]),
    });
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

// ---- social history ----

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

// Collect providers from the Care Teams section. Not a clinical
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

// Medications at Time of Discharge (#266): the take-home regimen on an inpatient
// discharge document — the closest analog of the ambulatory med list, so the
// entry's own coded status/effectiveTime are trusted (an "active" discharge med IS
// the intended ongoing medication); each derived course is tagged with an
// "At hospital discharge" provenance note.
export const dischargeMedicationsExtractor: SectionExtractor = {
  key: "dischargeMedications",
  matches: (s) => sectionIs(s, SECTIONS.dischargeMedications),
  extract: (s, documentDate) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(
            e?.substanceAdministration,
            narrativeIds,
            documentDate,
            {
              courseNote: "At hospital discharge",
            }
          )
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};

// Administered Medications (#266): meds GIVEN during the stay — a snapshot of
// past administrations, never an ongoing regimen, so mapMedication runs in
// snapshot mode (active/unstated status capped to `completed`; undated entries
// anchored to the document date) with an "Administered during encounter" note.
export const administeredMedicationsExtractor: SectionExtractor = {
  key: "administeredMedications",
  matches: (s) => sectionIs(s, SECTIONS.administeredMedications),
  extract: (s, documentDate) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(
            e?.substanceAdministration,
            narrativeIds,
            documentDate,
            {
              snapshot: true,
              courseNote: "Administered during encounter",
            }
          )
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};

// Ordered Prescriptions (#268): the prescriptions WRITTEN at the visit — Epic's
// order list, not the patient's current regimen (the Medications section remains
// the authority for that). The entries are the same Medication Activity (4.16)
// shape, so mapMedication parses them nearly unchanged — but in snapshot mode:
// the section documents an order EVENT, so an active/unstated status is capped to
// `completed` and an undated order anchors to the document date, meaning an order
// from a years-old visit can never fabricate a current (open-course) medication.
// A period with explicit bounds keeps them. Each derived course is tagged
// "Ordered at visit" so its provenance survives into the app.
export const orderedPrescriptionsExtractor: SectionExtractor = {
  key: "orderedPrescriptions",
  matches: (s) => sectionIs(s, SECTIONS.orderedPrescriptions),
  extract: (s, documentDate) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(
            e?.substanceAdministration,
            narrativeIds,
            documentDate,
            {
              snapshot: true,
              courseNote: "Ordered at visit",
            }
          )
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};

// Functional Status (#268): assessment observations ("ambulates independently",
// ADL/IADL findings, …) carried as organizer→component or bare observations — the
// SAME node shapes the Results walker reads, with coded (qualitative) or numeric
// values, so they route through the shared observation mapper as `lab` records.
// The assessment LOINC is stripped from the STORED record (after the mapper has
// used it for the name fallback and the stable external_id): these are assessment
// instruments, not lab analytes, so carrying the code forward would list every
// functional-status code in the "Unmapped lab codes" report — inviting canonical
// biomarker-map additions that would be wrong — and could misroute a coded
// assessment through the LOINC-keyed vitals/height recognizers.
export const functionalStatusExtractor: SectionExtractor = {
  key: "functionalStatus",
  matches: (s) => sectionIs(s, SECTIONS.functionalStatus),
  extract: (s) => ({
    records: observationsFromEntries(
      s.entries,
      "lab",
      buildNarrativeIdMap(s.raw?.text)
    ).map((r) => ({ ...r, loinc: null })),
  }),
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

// History of Past Illness / "Resolved Problems" (#265): the same Problem Concern
// Act entries as the Problems section, landed in the conditions store with a
// section-level default status of `resolved` (see mapCondition).
export const pastIllnessExtractor: SectionExtractor = {
  key: "pastIllness",
  matches: (s) => sectionIs(s, SECTIONS.pastIllness),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      conditions: s.entries
        .map((e) => mapCondition(e?.act, narrativeIds, "resolved"))
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

// Social History: the smoking status becomes a condition row; the
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
  dischargeMedicationsExtractor,
  administeredMedicationsExtractor,
  orderedPrescriptionsExtractor,
  functionalStatusExtractor,
  careTeamsExtractor,
  allergiesExtractor,
  problemsExtractor,
  pastIllnessExtractor,
  encountersExtractor,
  proceduresExtractor,
  familyHistoryExtractor,
  carePlanExtractor,
  goalsExtractor,
  socialHistoryExtractor,
];

// ---- import DEBUGGER: drop-reason + coverage report ----
//
// The extractors above silently drop candidates: mapObservation returns null for a
// null-flavored "Comment(s)" row, mapImmunization for an unmapped vaccine code,
// mapAllergy for a "no known allergy" negation, and whole sections with no matching
// extractor are skipped by the walker (Insurance deliberately so — see SECTIONS).
// This block RECORDS each drop + why, and which sections were / weren't
// consumed, WITHOUT changing what imports. It re-runs the same leaf mappers (pure,
// cheap) and classifies the ones that came back null, so the mappers themselves stay
// untouched — the report is built at the extractor-framework level.
