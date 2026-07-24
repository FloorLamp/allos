import type {
  ImportDemographics,
  ImportResult,
  ImportedAllergy,
  ImportedCareGoal,
  ImportedCarePlanItem,
  ImportedCondition,
  ImportedEncounter,
  ImportedFamilyHistory,
  ImportedImagingStudy,
  ImportedImmunization,
  ImportedProcedure,
  ImportedProvider,
  ImportedRecord,
} from "../health-import";
import type { ImportDrop, ImportReport } from "../import-report";
import { dedupeProviders } from "../providers";
import { isZip, readZip } from "../zip";
import { CdaError } from "./constants";
import type { CdaSection, SectionExtractor } from "./constants";
import {
  buildCcdaCoverage,
  dedupeDrops,
  recordDropKind,
  recordDropSection,
  unmappedLoincsFromRecords,
} from "./coverage";
import type {
  ClinicalNote,
  EncompassingEncounterInfo,
  StandaloneVisitDiagnosis,
} from "./extractors";
import {
  DEFAULT_EXTRACTORS,
  chiefComplaintsFromSections,
  clinicalNotesFromSections,
  encompassingEncounterInfo,
  selectReasonTarget,
  serviceEventProviders,
  socialHistorySex,
  visitDiagnosesFromSections,
} from "./extractors";
import { decideImportedConditionStatus } from "../clinical-parse";
import { asArray, effTime, hl7Date, parser, textOf } from "./normalize";

// Detect a CCD/CDA XML string (vs a SMART Health Card / other).
export function looksLikeCda(text: string): boolean {
  return /<ClinicalDocument[\s>]/.test(text.slice(0, 4000));
}

// Refuse a document that declares its own DTD entities (issue #135, item 5). The
// standard XML entities (&amp; &lt; …) need NO declaration; a `<!ENTITY>` in the
// internal DTD subset is the billion-laughs / XXE vector, and no legitimate C-CDA
// export defines one. We scan the DOCTYPE region — everything before the root
// element, where the internal subset must live — so a literal "<!ENTITY" sitting
// inside body text can't false-positive. Pure (raw-string scan, no parse), so it
// runs BEFORE the parser sees the bytes and is independent of the parser's own DTD
// posture. Unit-tested in lib/__tests__/cda-hardening.test.ts.
export function hasInternalDtdEntities(xml: string): boolean {
  const rootIdx = xml.search(/<(?:\w+:)?ClinicalDocument[\s>]/);
  // The internal subset precedes the root element; if we can't find the root, scan a
  // bounded prefix (the prolog is always near the top) rather than the whole file.
  const prolog = rootIdx >= 0 ? xml.slice(0, rootIdx) : xml.slice(0, 8192);
  return /<!ENTITY\b/i.test(prolog);
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
  const patientRole = asArray(cd?.recordTarget)
    .map((rt: any) => rt?.patientRole)
    .find((pr: any) => pr?.patient);
  const patient = patientRole?.patient;
  if (!patient) return null;
  const birthdate = hl7Date(patient?.birthTime?.["@_value"]);
  const g = patient?.administrativeGenderCode?.["@_code"];
  const sex = g === "M" ? "male" : g === "F" ? "female" : null;
  const name = cdaName(patient);
  // The patient's OWN address lives on patientRole/addr (a sibling of <patient>).
  // We take ONLY the postal code (issue #570) — it resolves offline to a coarse
  // ZIP-centroid home-location SUGGESTION, never a street address. Handle addr being
  // an array or a single node, and a nullFlavor'd/empty postalCode.
  const addr = Array.isArray(patientRole?.addr)
    ? patientRole.addr[0]
    : patientRole?.addr;
  const postalCode = normalizePostalCode(addr?.postalCode);
  if (!birthdate && !sex && !name && !postalCode) return null;
  return { sex, birthdate, name, postalCode };
}

// The XML parser coerces a bare numeric <postalCode> (e.g. 62704) to a NUMBER,
// which also strips a leading zero from a north-eastern ZIP (07001 → 7001). Coerce
// back to a string and re-pad a short all-digit value to the 5-digit ZIP form so the
// offline centroid lookup (#570) still resolves it. Non-numeric (ZIP+4, non-US)
// values pass through as trimmed text.
function normalizePostalCode(raw: unknown): string | null {
  let s: string | null;
  if (typeof raw === "number") s = String(raw);
  else s = textOf(raw)?.trim() ?? null;
  if (!s) return null;
  if (/^\d{1,4}$/.test(s)) s = s.padStart(5, "0");
  return s;
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
  // The document's encompassing visit (componentOf/encompassingEncounter), used to
  // pick which encounter the Reason for Visit attaches to when a hospital document
  // carries several Encounter Activities (issue #267). Null when absent.
  encompassingEncounter: EncompassingEncounterInfo | null;
  // Header-level care team (documentationOf/serviceEvent performers) — e.g. the
  // patient's PCP on an eCW document. Unioned into the import's providers.
  serviceEventProviders: ImportedProvider[];
} {
  // Reject a hostile internal DTD subset (#135 item 5) before parsing — no
  // legitimate C-CDA declares custom entities, so a `<!ENTITY>` is an attack shape.
  if (hasInternalDtdEntities(xml)) {
    throw new CdaError(
      "Refusing a CCD/CDA that declares custom DTD entities (unsupported / unsafe)."
    );
  }
  let doc: any;
  try {
    // CDA narrative uses <br/> for the visual line breaks inside a cell; the XML
    // parser drops the empty tag and fuses the surrounding text runs into one string
    // with no separator ("…aureusNo anaerobes…"). Convert each to a newline up front so
    // the break survives into the text node: the collapsed name map normalizes it back
    // to a space (lab/vital names stay single-line), while the report/impression BLOCK
    // map (#708) keeps it as a real line break for NotesText's pre-wrap rendering.
    doc = parser.parse(xml.replace(/<br\s*\/?>/gi, "\n"));
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
    encompassingEncounter: encompassingEncounterInfo(cd),
    serviceEventProviders: serviceEventProviders(cd),
  };
}

// ---- shared field helpers ----

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

// Per-field combiners for mergeDedupe: a listed field is merged with its function
// (which must handle empties itself and be idempotent) instead of the default
// empty-only backfill.
type FieldCombiners<T> = {
  [K in keyof T]?: (kept: T[K], incoming: T[K]) => T[K];
};

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
//
// `combine` overrides the backfill for named fields — used for encounter `notes`,
// where first-wins loses data: two documents can carry DIFFERENT non-empty notes
// for the same encounter (issue #262 — a bigger doc's short note would block the
// smaller doc's full progress note), so notes are line-folded instead.
function mergeDedupe<T extends { external_id: string }>(
  rows: T[],
  combine?: FieldCombiners<T>
): T[] {
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
      const combiner = combine?.[k];
      if (combiner) {
        kept[k] = combiner(kept[k], row[k]);
      } else if (isEmptyField(kept[k]) && !isEmptyField(row[k])) {
        kept[k] = row[k];
      }
    }
  }
  return order.map((id) => byId.get(id)!);
}

// An uncorrelatable standalone visit diagnosis → a problem-list condition. Given a
// visit-diagnosis provenance namespace on its external_id so it's stored as a real
// condition (tied to the document like any other) yet never conflated with an
// Active-Problems row of the same name.
function visitDiagnosisToCondition(
  d: StandaloneVisitDiagnosis,
  documentDate: string | null
): ImportedCondition {
  // For a visit diagnosis the visit date IS the diagnosis date (#590): use the
  // encounter/document date as onset when the narrative carried none — accurate,
  // not fabricated. Then let the import intelligence downgrade an episodic
  // self-limited / birth-event dx to resolved (a chronic-capable dx stays active).
  // A visit dx never carries an explicit clinical-status observation.
  const onset = d.onset_date ?? documentDate;
  const decided = decideImportedConditionStatus({
    name: d.name,
    code: d.code,
    status: "active",
    onsetDate: onset,
    resolvedDate: null,
    explicitStatus: false,
    episodic: true,
  });
  return {
    name: d.name,
    code: d.code,
    code_system: d.code_system,
    status: decided.status,
    onset_date: decided.onset_date,
    resolved_date: decided.resolved_date,
    external_id: `ccda:visit-dx:${d.name.toLowerCase()}:${d.code ?? ""}:${
      onset ?? ""
    }`,
  };
}

// The MyChart/Epic per-org sharing disclaimer that Health Information Exchange
// stamps into every shared document as a "Note from <org>" section (issue #262):
// "This document contains information that was shared with <recipient>. It may not
// contain the entire record from <org>." It is boilerplate, not clinical content —
// attaching it as a note pollutes real encounters and, in a document with no
// encounter section, materializes a spurious note-only encounter. Matched
// STRUCTURALLY (the two-sentence skeleton with free-form, period-free name spans;
// minor wording variants tolerated), and ANCHORED to the whole text — a real note
// that merely mentions sharing, or carries clinical content around the boilerplate,
// must never match (false negatives are benign; false positives drop real notes).
const SHARING_DISCLAIMER_RE =
  /^this document contains (?:health )?information that was shared with [^.!?]{1,160}\. ?it may not (?:contain|include) (?:the |your )?(?:entire|complete|full) (?:health |medical )?records? (?:from|of) [^.!?]{1,160}\.?$/i;

// Whether a note body is, in its ENTIRETY, the sharing-disclaimer boilerplate.
// Pure; unit-tested in lib/__tests__/cda-notes-diagnoses.test.ts.
export function isSharingDisclaimer(text: string): boolean {
  return SHARING_DISCLAIMER_RE.test(text.replace(/\s+/g, " ").trim());
}

// Fold incoming note lines into an existing free-text block, deduping by line
// (case-insensitive) so re-folding the same note is idempotent. Returns the merged
// block, or null when there is nothing.
function foldNoteLines(
  existing: string | null,
  incoming: string[]
): string | null {
  const lines = existing ? existing.split("\n") : [];
  const seen = new Set(lines.map((l) => l.toLowerCase()));
  for (const line of incoming) {
    if (!line.trim()) continue;
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    lines.push(line);
  }
  return lines.length ? lines.join("\n") : null;
}

// A note line for attaching to an encounter that already has its own performer:
// prefix the authoring clinician's name for attribution when the section named one.
function attributedNoteLine(n: ClinicalNote): string {
  const author = n.author?.name?.trim();
  return author ? `${author}: ${n.text}` : n.text;
}

// Fold clinical-note text into an encounter's existing free-text notes, deduping by
// line (so re-attaching the same note is idempotent). Returns the merged block, or
// null when there is nothing.
function mergeEncounterNotes(
  existing: string | null,
  notes: ClinicalNote[]
): string | null {
  return foldNoteLines(existing, notes.map(attributedNoteLine));
}

// mergeDedupe combiner for encounter `notes` across documents: union the DISTINCT
// note lines (kept-row lines first, then any the incoming copy adds), rather than
// first-wins or longest-wins. Concatenation is the safe semantics — two documents'
// copies of one encounter can each carry a real note the other lacks, and
// longest-wins would still drop the shorter one; the line-level dedup keeps the
// merge idempotent when the copies share lines (issue #262).
function mergeNoteBlocks(
  kept: string | null,
  incoming: string | null
): string | null {
  return foldNoteLines(kept, incoming ? incoming.split("\n") : []);
}

// An uncorrelatable clinical note → a standalone dated note entry, modeled as a
// note-only encounter (reusing the encounters store + its notes render/search — no
// new table). The note's author becomes the encounter's provider (so the text is
// stored unprefixed); the section title labels the visit type. Null when no date can
// be resolved (a note we can't place on a day).
function clinicalNoteToEncounter(
  n: ClinicalNote,
  documentDate: string | null
): ImportedEncounter | null {
  const date = n.date ?? documentDate;
  if (!date) return null;
  const label = (n.title ?? "note").toLowerCase().replace(/\s+/g, "-");
  const snippet = n.text.slice(0, 60).toLowerCase().replace(/\s+/g, " ").trim();
  return {
    date,
    end_date: null,
    type: n.title ?? "Clinical Note",
    code: null,
    code_system: null,
    class_code: null,
    reason: null,
    diagnoses: [],
    provider: n.author,
    location: null,
    notes: n.text,
    external_id: `ccda:note:${date}:${label}:${snippet}`,
  };
}

// Run the given extractors over a CCD. Each section is handed to the first
// extractor that matches it; results are merged and de-duplicated.
export function extractFromCcda(
  xml: string,
  extractors: SectionExtractor[] = DEFAULT_EXTRACTORS
): ImportResult {
  const {
    sections,
    demographics,
    documentDate,
    encompassingEncounter,
    serviceEventProviders: headerProviders,
  } = parseCcdaDocument(xml);
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
  const imagingStudies: ImportedImagingStudy[] = [];
  // Sections a registered extractor claimed. The document-level note / visit-
  // diagnosis correlation below runs ONLY over the leftover (unclaimed) sections, so
  // a real content section that happens to be titled "… Notes" can never be
  // double-processed as a note.
  const claimedSections = new Set<CdaSection>();
  // The date undated entries anchor to (see SectionExtractor.contextDate): the
  // header visit's date when present — a per-visit document's effectiveTime is its
  // GENERATION timestamp, possibly days after the visit — else the document date.
  const contextDate = encompassingEncounter?.start ?? documentDate;
  for (const section of sections) {
    const ex = extractors.find((e) => e.matches(section));
    if (!ex) continue;
    claimedSections.add(section);
    const part = ex.extract(section, contextDate);
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
    if (part.imagingStudies) imagingStudies.push(...part.imagingStudies);
  }
  // Correlate the document-level Reason for Visit / chief complaint onto the
  // encounter when the encounter carries none of its own. In an Epic per-visit CCD
  // the reason section describes the single encounter in the same document; a
  // hospital document that ships several Encounter Activities (the visit plus a
  // companion event-type activity — #267) is disambiguated by the document's
  // encompassing visit (selectReasonTarget). Genuinely ambiguous cases still skip.
  const deduped = dedupe(encounters);
  // A document whose sections yield NO encounter but whose header carries the visit
  // (componentOf/encompassingEncounter) imports the header visit as THE encounter —
  // the eClinicalWorks packaging, vs Epic's Encounters-section Encounter Activities.
  // This keeps the visit's real clinician/facility, and gives the document-level
  // correlations below (reason for visit, clinical notes, standalone visit
  // diagnoses) their single encounter to attach to — without it, each note section
  // fabricates its own note-only encounter and the reason drops as unattributable.
  if (deduped.length === 0 && encompassingEncounter?.activity) {
    deduped.push(encompassingEncounter.activity);
  }
  // Whether the Reason-for-Visit section was actually consumed (correlated). Only
  // true when selectReasonTarget resolves a single reason-less encounter to attach
  // the chief complaint to AND the section carried one — the same condition the
  // coverage report reflects (F2).
  let reasonForVisitConsumed = false;
  const reasonTarget = selectReasonTarget(deduped, encompassingEncounter);
  if (reasonTarget >= 0) {
    const reasons = chiefComplaintsFromSections(sections);
    if (reasons.length) {
      deduped[reasonTarget].reason = reasons.join("; ");
      reasonForVisitConsumed = true;
    }
  }
  // The sections the extractor loop did NOT claim — the only ones eligible to be a
  // note / standalone visit-diagnosis surface (the encounters/problems/etc. sections
  // are already claimed and must not be reprocessed here).
  const leftover = sections.filter((s) => !claimedSections.has(s));
  // Standalone Visit Diagnoses (top-level 29308-4): correlate onto the same-document
  // encounter when there is exactly ONE (mirroring Reason for Visit) by folding the
  // names into its diagnosis list (deduped against the nested ones it may already
  // carry — so a CCD that ships BOTH packagings doesn't double-list). With zero or
  // several encounters we can't attribute reliably, so each lands as a problem-list
  // condition carrying its visit-diagnosis provenance (a distinct external_id
  // namespace, so it's never conflated with an Active-Problems row).
  const visitDiagnoses = visitDiagnosesFromSections(leftover);
  if (deduped.length === 1) {
    const target = deduped[0];
    const seenDx = new Set(target.diagnoses.map((d) => d.toLowerCase()));
    for (const d of visitDiagnoses) {
      if (seenDx.has(d.name.toLowerCase())) continue;
      seenDx.add(d.name.toLowerCase());
      target.diagnoses.push(d.name);
    }
  } else {
    for (const d of visitDiagnoses) {
      conditions.push(visitDiagnosisToCondition(d, documentDate));
    }
  }
  // Progress Notes + per-clinician Notes: attach to the same-document encounter's
  // free-text notes when there is exactly one (extending the #71 visit-narrative
  // model — the note's author is prefixed for attribution since the encounter carries
  // its own performer); else store each as a standalone dated note (a note-only
  // encounter row, whose provider IS the note author). A note with no date and no
  // document date can't be placed as a standalone entry and is dropped. A note that
  // is entirely the sharing-disclaimer boilerplate is skipped up front (#262): it is
  // not clinical content, and letting it attach both pollutes the encounter's notes
  // and — in a document with no encounter section — fabricates a note-only
  // encounter out of pure boilerplate.
  const clinicalNotes = clinicalNotesFromSections(leftover).filter(
    (n) => !isSharingDisclaimer(n.text)
  );
  if (deduped.length === 1) {
    deduped[0].notes = mergeEncounterNotes(deduped[0].notes, clinicalNotes);
  } else {
    for (const n of clinicalNotes) {
      const enc = clinicalNoteToEncounter(n, documentDate);
      if (enc) deduped.push(enc);
    }
  }
  // Enrich the header demographics with the Social History sex — the
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
  const keptImagingStudies = dedupe(imagingStudies).sort((a, b) =>
    (a.study_date ?? "").localeCompare(b.study_date ?? "")
  );

  // Import DEBUGGER report: coverage + section drops from the
  // walker, plus the per-kind `deduped` drops and the kept-vs-considered counts.
  const { coverage, drops } = buildCcdaCoverage(
    sections,
    extractors,
    reasonForVisitConsumed,
    contextDate
  );
  drops.push(
    ...dedupeDrops(
      records,
      (r) => recordDropKind(r.category),
      (r) => r.name,
      (r) => recordDropSection(r.category)
    ),
    ...dedupeDrops(
      immunizations,
      () => "immunization",
      (i) => i.code,
      () => "Immunizations"
    ),
    ...dedupeDrops(
      allergies,
      () => "allergy",
      (a) => a.substance,
      () => "Allergies"
    ),
    ...dedupeDrops(
      conditions,
      () => "condition",
      (c) => c.name,
      () => "Problems"
    ),
    ...dedupeDrops(
      encounters,
      () => "encounter",
      (e) => e.type ?? e.date,
      () => "Encounters"
    ),
    ...dedupeDrops(
      procedures,
      () => "procedure",
      (p) => p.name,
      () => "Procedures"
    ),
    ...dedupeDrops(
      familyHistory,
      () => "family_history",
      (f) => `${f.relation ?? "Relative"}: ${f.condition}`,
      () => "Family History"
    ),
    ...dedupeDrops(
      carePlanItems,
      () => "care_plan",
      (c) => c.description,
      () => "Care Plan"
    ),
    ...dedupeDrops(
      careGoals,
      () => "care_goal",
      (g) => g.description,
      () => "Goals"
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
    imagingStudies: keptImagingStudies,
    demographics: enrichedDemographics,
    // Section-level providers (Care Teams) plus the header's serviceEvent
    // performers (the stated PCP / appointment provider). Per-reading performers
    // ride on the records/immunizations above; import-persist unions them all and
    // dedups globally when resolving them into the shared registry.
    providers: [...providers, ...headerProviders],
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
  const imagingStudies: ImportedImagingStudy[] = [];
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
    imagingStudies.push(...(r.imagingStudies ?? []));
    providers.push(...(r.providers ?? []));
    // Demographics come from the FIRST document that carries any (callers order
    // largest-first). NB: this is a whole-OBJECT pick, not a field-level merge — so
    // if the largest document's header states a sex but a SMALLER document is the
    // only one whose Social History codes a sex, the smaller doc's
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
  // Encounter notes are line-folded (union of distinct lines) instead of
  // first-wins-backfilled: two documents' copies of one encounter can carry
  // DIFFERENT non-empty notes, and keeping only the first copy's silently drops
  // the other's (#262).
  const keptEncounters = mergeDedupe(encounters, {
    notes: mergeNoteBlocks,
  }).sort((a, b) => b.date.localeCompare(a.date));
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
  const keptImagingStudies = mergeDedupe(imagingStudies).sort((a, b) =>
    (a.study_date ?? "").localeCompare(b.study_date ?? "")
  );

  // Merge the per-document reports: coverage + drops concat
  // (the view dedups coverage by title), plus the CROSS-document `deduped` drops —
  // the rows mergeDedupe collapsed because a section (Results/Allergies/…) appears
  // in both DOC0001 and DOC0002. `imported` is the final merged row count.
  const crossDocDrops: ImportDrop[] = [
    ...dedupeDrops(
      records,
      (r) => recordDropKind(r.category),
      (r) => r.name,
      (r) => recordDropSection(r.category)
    ),
    ...dedupeDrops(
      immunizations,
      () => "immunization",
      (i) => i.code,
      () => "Immunizations"
    ),
    ...dedupeDrops(
      allergies,
      () => "allergy",
      (a) => a.substance,
      () => "Allergies"
    ),
    ...dedupeDrops(
      conditions,
      () => "condition",
      (c) => c.name,
      () => "Problems"
    ),
    ...dedupeDrops(
      encounters,
      () => "encounter",
      (e) => e.type ?? e.date,
      () => "Encounters"
    ),
    ...dedupeDrops(
      procedures,
      () => "procedure",
      (p) => p.name,
      () => "Procedures"
    ),
    ...dedupeDrops(
      familyHistory,
      () => "family_history",
      (f) => `${f.relation ?? "Relative"}: ${f.condition}`,
      () => "Family History"
    ),
    ...dedupeDrops(
      carePlanItems,
      () => "care_plan",
      (c) => c.description,
      () => "Care Plan"
    ),
    ...dedupeDrops(
      careGoals,
      () => "care_goal",
      (g) => g.description,
      () => "Goals"
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
    imagingStudies: keptImagingStudies,
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
