import type {
  ImportDemographics,
  ImportResult,
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
import type { ImportDrop, ImportReport } from "../import-report";
import { dedupeProviders } from "../providers";
import { isZip, readZip } from "../zip";
import { CdaError } from "./constants";
import type { CdaSection, SectionExtractor } from "./constants";
import {
  buildCcdaCoverage,
  dedupeDrops,
  recordDropKind,
  unmappedLoincsFromRecords,
} from "./coverage";
import type { ClinicalNote, StandaloneVisitDiagnosis } from "./extractors";
import {
  DEFAULT_EXTRACTORS,
  chiefComplaintsFromSections,
  clinicalNotesFromSections,
  socialHistorySex,
  visitDiagnosesFromSections,
} from "./extractors";
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
  // Reject a hostile internal DTD subset (#135 item 5) before parsing — no
  // legitimate C-CDA declares custom entities, so a `<!ENTITY>` is an attack shape.
  if (hasInternalDtdEntities(xml)) {
    throw new CdaError(
      "Refusing a CCD/CDA that declares custom DTD entities (unsupported / unsafe)."
    );
  }
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

// An uncorrelatable standalone visit diagnosis → a problem-list condition. Given a
// visit-diagnosis provenance namespace on its external_id so it's stored as a real
// condition (tied to the document like any other) yet never conflated with an
// Active-Problems row of the same name.
function visitDiagnosisToCondition(
  d: StandaloneVisitDiagnosis
): ImportedCondition {
  return {
    name: d.name,
    code: d.code,
    code_system: d.code_system,
    status: "active",
    onset_date: d.onset_date,
    resolved_date: null,
    external_id: `ccda:visit-dx:${d.name.toLowerCase()}:${d.code ?? ""}:${
      d.onset_date ?? ""
    }`,
  };
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
  const lines = existing ? existing.split("\n") : [];
  const seen = new Set(lines.map((l) => l.toLowerCase()));
  for (const n of notes) {
    const line = attributedNoteLine(n);
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    lines.push(line);
  }
  return lines.length ? lines.join("\n") : null;
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
  // Sections a registered extractor claimed. The document-level note / visit-
  // diagnosis correlation below runs ONLY over the leftover (unclaimed) sections, so
  // a real content section that happens to be titled "… Notes" can never be
  // double-processed as a note.
  const claimedSections = new Set<CdaSection>();
  for (const section of sections) {
    const ex = extractors.find((e) => e.matches(section));
    if (!ex) continue;
    claimedSections.add(section);
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
      conditions.push(visitDiagnosisToCondition(d));
    }
  }
  // Progress Notes + per-clinician Notes: attach to the same-document encounter's
  // free-text notes when there is exactly one (extending the #71 visit-narrative
  // model — the note's author is prefixed for attribution since the encounter carries
  // its own performer); else store each as a standalone dated note (a note-only
  // encounter row, whose provider IS the note author). A note with no date and no
  // document date can't be placed as a standalone entry and is dropped.
  const clinicalNotes = clinicalNotesFromSections(leftover);
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

  // Import DEBUGGER report: coverage + section drops from the
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

  // Merge the per-document reports: coverage + drops concat
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
