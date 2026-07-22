// CDA section extractors — encounters, visits, and clinical notes. The encounter
// mapper and its helpers, the reason-for-visit / visit-diagnoses / clinical-note
// derivations, and the encounters section extractor.
import { isNoKnownProblemText } from "../../clinical-parse";
import type { ImportedEncounter, ImportedProvider } from "../../health-import";
import {
  ACT_CODE_OID,
  CLINICAL_NOTE_LOINCS,
  COMMENT_ACT_TEMPLATE,
  PROBLEM_OBS_TEMPLATE,
  SECTIONS,
  VALUE_PLACEHOLDERS,
} from "../constants";
import type { CdaSection, SectionExtractor } from "../constants";
import {
  addressOf,
  asArray,
  buildNarrativeIdMap,
  codeSystemLabel,
  codedDisplayName,
  collectText,
  effTime,
  hl7Date,
  hl7Period,
  otherIdentifier,
  pickCode,
  providerFromAssignedEntity,
  providerFromPerformer,
  resolveNarrativeText,
  sectionIs,
  telecomOf,
  textOf,
  truthyNegation,
} from "../normalize";

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

// The encounter TYPE code + system off the encounter <code> (issue #1035) — the
// CPT/CDT/local coding the display `type` resolves from, feeding the preventive
// concept map's visit-rule code sets. The procedures pattern (pickCode) minus one
// wrinkle: the ActEncounterCode class (AMB/IMP/EMER) rides the SAME <code> as a
// <translation> (or occasionally as the top-level coding), and it already lands
// in `class_code` — so ActCode codings are skipped here rather than ever being
// stored as the "type code". Prefers the top-level coding, then the first
// non-ActCode translation; nullFlavor codings are ignored.
function encounterTypeCode(code: any): {
  code: string | null;
  system: string | null;
} {
  for (const c of [code, ...asArray(code?.translation)]) {
    if (!c || c["@_code"] == null || c["@_nullFlavor"] != null) continue;
    if (c["@_codeSystem"] === ACT_CODE_OID) continue; // the class, not the type
    return {
      code: String(c["@_code"]),
      system: codeSystemLabel(c["@_codeSystem"]),
    };
  }
  return { code: null, system: null };
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
  const { code, system } = encounterTypeCode(enc?.code);
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
    code,
    code_system: system,
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
  // The header visit as a full encounter row. Some systems (eClinicalWorks) put the
  // visit ONLY here — their Encounters section is empty — so when the section
  // extractors yield no encounter, extractFromCcda imports this one instead of
  // leaving the visit (and its responsible clinician + facility) behind.
  activity: ImportedEncounter | null;
}

// Friendly labels for the HL7 ActEncounterCode classes. There is no canonical
// encounter-type vocabulary in the app — `type` is display text from the source —
// so when the header visit's <code> carries ONLY the class (eClinicalWorks emits
// a bare AMB with displayName "ambulatory"), the class label supplies a readable
// type instead of that lowercase code-system text.
const ENCOUNTER_CLASS_LABELS: Record<string, string> = {
  AMB: "Ambulatory",
  IMP: "Inpatient",
  ACUTE: "Inpatient acute",
  NONAC: "Inpatient non-acute",
  EMER: "Emergency",
  FLD: "Field",
  HH: "Home health",
  OBSENC: "Observation",
  PRENC: "Pre-admission",
  SS: "Short stay",
  VR: "Virtual",
};

// The document-level care team from the header's documentationOf/serviceEvent
// performers — where an eCW document states the patient's PCP (functionCode PCP)
// and the appointment provider. These ride on no section, so they're surfaced as
// document-level providers; import-persist unions them into the shared registry
// with the Care Teams / per-reading ones and dedups globally.
export function serviceEventProviders(cd: any): ImportedProvider[] {
  const out: ImportedProvider[] = [];
  for (const d of asArray(cd?.documentationOf)) {
    for (const p of asArray(d?.serviceEvent?.performer)) {
      const prov = providerFromAssignedEntity(p?.assignedEntity, "individual");
      if (prov) out.push(prov);
    }
  }
  return out;
}

// The visit facility from the encompassing encounter's
// location/healthCareFacility/serviceProviderOrganization, as an organization
// provider. Unlike an Encounter Activity's LOC participant, the org node carries its
// name/telecom/addr directly.
function encompassingLocation(ee: any): ImportedProvider | null {
  const org = ee?.location?.healthCareFacility?.serviceProviderOrganization;
  const nm = Array.isArray(org?.name) ? org.name[0] : org?.name;
  const name = textOf(nm)?.trim();
  if (!name) return null;
  return {
    name,
    type: "organization",
    npi: null,
    identifier: otherIdentifier(org),
    phone: telecomOf(org),
    address: addressOf(org),
  };
}

// Map the encompassing encounter to an ImportedEncounter, or null when it carries
// no usable date. The header shape differs from an Encounter Activity: the clinician
// is the responsibleParty's assignedEntity (not a performer) and the facility is the
// serviceProviderOrganization (not a LOC participant). The <code> is typically the
// bare ActEncounterCode class (AMB/IMP/EMER), so class_code usually resolves while
// the type code stays null and the type display falls back to the class displayName
// ("ambulatory"). The external_id reuses the visit's source id in the SAME
// "ccda:encounter:<id>" namespace as an Encounter Activity, so a companion document
// that DOES list the visit in its Encounters section collapses to one row in the
// XDM merge.
function mapEncompassingEncounter(ee: any): ImportedEncounter | null {
  const { start, end } = hl7Period(ee?.effectiveTime);
  const date = start ?? effTime(ee?.effectiveTime);
  if (!date) return null;
  const { code, system } = encounterTypeCode(ee?.code);
  const classCode = encounterClassCode(ee?.code);
  const display = codedDisplayName(ee?.code, {});
  const classLabel = classCode
    ? (ENCOUNTER_CLASS_LABELS[classCode] ?? null)
    : null;
  // With no real type coding, the display is just the class's own lowercase
  // displayName — prefer the canonical class label.
  const type = code == null ? (classLabel ?? display) : (display ?? classLabel);
  const idExt = firstEncounterId(ee);
  return {
    date,
    end_date: end,
    type,
    code,
    code_system: system,
    class_code: classCode,
    reason: null,
    diagnoses: [],
    provider: providerFromAssignedEntity(
      ee?.responsibleParty?.assignedEntity,
      "individual"
    ),
    location: encompassingLocation(ee),
    notes: null,
    external_id: idExt
      ? `ccda:encounter:${idExt}`
      : `ccda:encounter:${date}:encompassing`,
  };
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
    activity: mapEncompassingEncounter(ee),
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
// Whether a section is a Standalone Visit Diagnoses surface. Three packagings, all
// routed into the same visit-diagnosis handling: the 29308-4 "Diagnosis" section
// (#249), the Assessment Section (LOINC 51848-0 / templateId 2.2.8) Epic emits its
// narrative-only Visit Diagnoses as (#263), and — as a last-resort catch for a
// deployment-specific code we haven't catalogued — any section titled "Visit
// Diagnos(es/is)". Admitting Diagnoses (#266) route through the same walk too but are
// matched separately (matchesAdmission) so they keep their own provenance/act shape.
export function isVisitDiagnosesSection(section: CdaSection): boolean {
  if (
    sectionIs(section, SECTIONS.visitDiagnoses) ||
    sectionIs(section, SECTIONS.assessments)
  )
    return true;
  const title = section.title?.trim().toLowerCase();
  return !!title && /\bvisit diagnos(?:i|e)s\b/.test(title);
}

// Diagnosis names read from a section's narrative <table> — the fallback for a
// narrative-only Visit Diagnoses / Assessment section (#263) whose clinical content
// lives ONLY in an HTML table of diagnosis names, with ZERO structured entries (so
// the Problem-Observation deep-walk finds nothing). Reads the first cell of each body
// <tr> (Epic's Visit Diagnoses table leads with the diagnosis name), skipping header
// rows (which carry <th>, not <td>) and "no known problems" placeholders. A section
// with no <table> (free-text prose) yields nothing, so a genuine narrative assessment
// is never mis-parsed into fabricated diagnoses. Dedups within the section.
export function narrativeDiagnosisNames(sectionRaw: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const table of asArray(sectionRaw?.text?.table)) {
    // Body rows: prefer an explicit <tbody>, else the <tr> directly under <table>.
    const bodyRows = table?.tbody
      ? asArray(table.tbody).flatMap((b: any) => asArray(b?.tr))
      : asArray(table?.tr);
    for (const tr of bodyRows) {
      const cells = asArray(tr?.td);
      if (cells.length === 0) continue; // header row (<th> only) or empty
      const name = collectText(cells[0]).replace(/\s+/g, " ").trim();
      if (!name || isNoKnownProblemText(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

export function visitDiagnosesFromSections(
  sections: CdaSection[]
): StandaloneVisitDiagnosis[] {
  const out: StandaloneVisitDiagnosis[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    if (
      !isVisitDiagnosesSection(s) &&
      !sectionIs(s, SECTIONS.admissionDiagnoses)
    )
      continue;
    const ids = buildNarrativeIdMap(s.raw?.text);
    let fromEntries = 0;
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
            fromEntries++;
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
    // Narrative-only fallback (#263): a section that yielded NO structured Problem
    // Observation is the Assessment/"Visit Diagnoses" flavor whose diagnoses live only
    // in the printed <table>. Read the diagnosis names out of it (no code/onset — the
    // narrative carries none), deduped against everything captured so far so a CCD that
    // ships BOTH packagings never double-lists.
    if (fromEntries === 0) {
      for (const name of narrativeDiagnosisNames(s.raw)) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, code: null, code_system: null, onset_date: null });
      }
    }
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
  // "… Notes" — never let the title heuristic double-process it as a note. Covers the
  // 29308-4 / Assessment (51848-0) / "Visit Diagnoses"-titled surfaces (#263) and
  // Admitting Diagnoses (#266).
  if (
    isVisitDiagnosesSection(section) ||
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
// The author of the first Note Activity entry (<entry><act><author>, template
// 4.202) — where eClinicalWorks puts the note's clinician, rather than as a
// section-level author (4.119). Fallback only; a section-level author wins.
function firstNoteEntryAuthor(entries: any[]): any {
  for (const e of asArray(entries)) {
    const a = asArray(e?.act?.author)[0];
    if (a) return a;
  }
  return undefined;
}

export function clinicalNotesFromSections(
  sections: CdaSection[]
): ClinicalNote[] {
  const out: ClinicalNote[] = [];
  for (const s of sections) {
    if (!isClinicalNoteSection(s)) continue;
    const text = collectText(s.raw?.text).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const authorNode =
      asArray(s.raw?.author)[0] ?? firstNoteEntryAuthor(s.entries);
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
