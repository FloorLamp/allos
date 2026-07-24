import {
  canonicalBiomarkerForLoinc,
  isDerivedPercentileLoinc,
  isNonAnalyteLoinc,
  isUnmappedLabLoinc,
} from "../biomarker-loinc";
import { isNoKnownAllergy, isNoKnownProblemText } from "../clinical-parse";
import { codeFromVaccineCode } from "../cvx-map";
import type { ImportedRecord } from "../health-import";
import type { CoverageEntry, DropKind, ImportDrop } from "../import-report";
import { tallyUnmappedLoincs } from "../import-report";
import {
  ALLERGY_OBS_TEMPLATE,
  KNOWN_SECTION_TITLES,
  PROBLEM_OBS_TEMPLATE,
  SECTIONS,
} from "./constants";
import type { CdaSection, SectionExtractor } from "./constants";
import {
  isClinicalNoteSection,
  isVisitDiagnosesSection,
  mapAllergy,
  mapCondition,
  isRadiologyStudyObs,
  isReportNarrativeObs,
  mapImmunization,
  mapMedication,
  mapObservation,
  narrativeDrugName,
} from "./extractors";
import {
  asArray,
  buildNarrativeIdMap,
  codedDisplayName,
  collectText,
  effTime,
  loincDisplayName,
  loincFromCode,
  readValue,
  resolveNarrativeText,
  sectionIs,
  textOf,
  truthyNegation,
  vaccineCodeFrom,
} from "./normalize";

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
// the non-analyte administrative + derived-percentile drops, then the value: an
// explicit nullFlavor, a placeholder ("—"/"N/A"), or truly no value.
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
  // A non-analyte administrative row (specimen date, "Approved By", accession #) or a
  // derived anthropometric percentile is dropped by mapObservation before its value
  // is ever read (#681/#684/#722/#693) — each carries a real value and would
  // otherwise fall through to "other". Same order as mapObservation's guard.
  else if (isNonAnalyteLoinc(loincFromCode(obs?.code))) reason = "non_analyte";
  else if (isDerivedPercentileLoinc(loincFromCode(obs?.code)))
    reason = "derived_percentile";
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
// medication mapper — see the medication-course note): negated, else missing name/date.
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
  contextDate: string | null
): void {
  const ids = buildNarrativeIdMap(section.raw?.text);
  const title = sectionTitle(section);
  // functionalStatus (#268) routes through the SAME observation walk/mapper as
  // Results (as qualitative `lab` records — the stored-record loinc strip in its
  // extractor doesn't change whether an observation maps), so its drops are
  // itemized identically.
  if (key === "results" || key === "vitals" || key === "functionalStatus") {
    const cat = key === "vitals" ? "vitals" : "lab";
    for (const o of observationNodesOf(section.entries)) {
      // A radiology-study observation is CONSUMED into imaging_studies, and a
      // narrative report observation (ED-valued culture/gram-stain/cytology) is
      // CONSUMED into a `report` record — neither is a dropped lab (their nullFlavor /
      // ED value would otherwise read as a no_value/null_flavor drop).
      if (
        isRadiologyStudyObs(o) ||
        isReportNarrativeObs(o) ||
        mapObservation(o, cat, ids)
      )
        continue;
      drops.push(classifyObservationDrop(o, cat, ids, title));
    }
  } else if (key === "immunizations") {
    for (const e of section.entries) {
      const sa = e?.substanceAdministration;
      if (!sa || mapImmunization(sa)) continue;
      drops.push(classifyImmunizationDrop(sa, title));
    }
  } else if (
    key === "medications" ||
    key === "dischargeMedications" ||
    key === "administeredMedications" ||
    key === "orderedPrescriptions"
  ) {
    for (const e of section.entries) {
      const sa = e?.substanceAdministration;
      // Re-run the SAME mapper the kept-path uses (same narrative ids + context-date
      // fallback) so a now-imported undated med isn't miscounted as a drop (#Fix 2).
      // The #266 snapshot/note opts don't change whether a med maps (only its
      // course status), so the plain call is a faithful kept/dropped signal.
      if (!sa || mapMedication(sa, ids, contextDate)) continue;
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
  } else if (key === "problems" || key === "pastIllness") {
    for (const e of section.entries) {
      const act = e?.act;
      // The #265 section-default status doesn't change whether a concern act maps
      // (only which status it lands with), so the plain call is faithful here too.
      if (!act || mapCondition(act, ids)) continue;
      drops.push(classifyConditionDrop(act, ids, title));
    }
  }
}

// Labs that imported but carry a LOINC with no canonical mapping (Fix 3): a
// non-fatal "add these to LOINC_TO_CANONICAL" annotation surfaced in the debugger.
// Vitals (routed by isVitalLoinc) and code-less rows are excluded.
export function unmappedLoincsFromRecords(records: ImportedRecord[]) {
  return tallyUnmappedLoincs(
    records
      // A `report` row carries a report LOINC (34574-4/11502-2/33718-8) that is
      // deliberately NOT an analyte — it must never surface as an "add to
      // LOINC_TO_CANONICAL" suggestion (#708).
      .filter((r) => r.category !== "report")
      .filter((r) => isUnmappedLabLoinc(r.loinc))
      // unit is catalog identity (it rides into the "Report unmapped code"
      // prefill) — never the measured value itself.
      .map((r) => ({ loinc: r.loinc, name: r.name, unit: r.unit }))
  );
}

// Which drop kind a deduped medical_records row belongs to (by its category).
export function recordDropKind(category: string): DropKind {
  if (category === "vitals") return "vitals";
  if (category === "prescription") return "medication";
  return "lab";
}

// The source-path chip for a deduped medical_records row (#270: every drop kind
// carries a `section` so the Dropped list always shows where a row came from).
// Deduped rows have lost their originating <section> node by the time dedupe()
// runs, so this names the standard CCD section their category maps to.
export function recordDropSection(category: string): string {
  if (category === "vitals") return "Vital Signs";
  if (category === "prescription") return "Medications";
  return "Results";
}

// Drops for the rows dedupe() removes: dedupe() keeps the FIRST occurrence of each
// external_id, so every subsequent same-key row is a `deduped` drop. Mirrors
// dedupe()'s semantics exactly so the report matches what actually happened.
// `sectionOf` names the source path (#270) — for CDA rows the standard section
// title of the row's kind, since the original section node is gone by now.
export function dedupeDrops<T extends { external_id: string }>(
  rows: T[],
  kindOf: (r: T) => DropKind,
  labelOf: (r: T) => string,
  sectionOf: (r: T) => string
): ImportDrop[] {
  const seen = new Set<string>();
  const out: ImportDrop[] = [];
  for (const r of rows) {
    if (seen.has(r.external_id))
      out.push({
        kind: kindOf(r),
        label: labelOf(r),
        reason: "deduped",
        section: sectionOf(r),
      });
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
export function buildCcdaCoverage(
  sections: CdaSection[],
  extractors: SectionExtractor[],
  reasonForVisitConsumed: boolean,
  contextDate: string | null
): { coverage: CoverageEntry[]; drops: ImportDrop[] } {
  const coverage: CoverageEntry[] = [];
  const drops: ImportDrop[] = [];
  for (const section of sections) {
    const ex = extractors.find((e) => e.matches(section));
    const title = sectionTitle(section);
    const isReasonForVisit = sectionIs(section, SECTIONS.reasonForVisit);
    // The two document-level surfaces routed after the extractor loop (see
    // extractFromCcda). Unlike Reason for Visit these are ALWAYS consumed when
    // present: a standalone visit diagnosis correlates onto the encounter OR lands as
    // a condition, and a note attaches to the encounter OR becomes a standalone note —
    // so recognizing the section (not a runtime flag) is the right consumed signal.
    // `!!ex` keeps precedence, so a real content section titled "… Notes" stays owned
    // by its extractor and is never mis-attributed here. isVisitDiagnosesSection also
    // recognizes the narrative-only Assessment (51848-0 / 2.2.8) packaging and a
    // "Visit Diagnoses"-titled section (#263), so those are consumed, not flagged
    // unrecognized, even when they carry only a narrative table.
    const isVisitDiagnoses = isVisitDiagnosesSection(section);
    // Admitting Diagnoses (#266) route through the same document-level
    // visit-diagnosis handling (correlate-or-land), so like Visit Diagnoses the
    // section is always consumed when recognized.
    const isAdmissionDiagnoses = sectionIs(
      section,
      SECTIONS.admissionDiagnoses
    );
    const isClinicalNote = !ex && isClinicalNoteSection(section);
    // Insurance / Payers (#268) is recognized-but-IGNORED: coverage data is
    // deliberately out of scope (see SECTIONS.insurance), so the section is
    // neither consumed nor an unrecognized-section gap — it gets an `ignored`
    // coverage entry the debug view lists as "recognized, not imported".
    const isInsurance = !ex && sectionIs(section, SECTIONS.insurance);
    const consumed =
      !!ex ||
      (isReasonForVisit && reasonForVisitConsumed) ||
      isVisitDiagnoses ||
      isAdmissionDiagnoses ||
      isClinicalNote;
    const key =
      ex?.key ??
      (isReasonForVisit
        ? "reasonForVisit"
        : isVisitDiagnoses
          ? "visitDiagnoses"
          : isAdmissionDiagnoses
            ? "admissionDiagnoses"
            : isClinicalNote
              ? "clinicalNotes"
              : isInsurance
                ? "insurance"
                : "");
    coverage.push({
      key: key || title,
      title,
      consumed,
      present: section.entries.length,
      ...(isInsurance ? { ignored: true } : {}),
    });
    if (!consumed) {
      if (!isInsurance) {
        drops.push({
          kind: "section",
          label: title,
          reason: "unrecognized_section",
          section: title,
        });
      }
      continue;
    }
    if (ex) collectSectionDrops(section, ex.key, drops, contextDate);
  }
  return { coverage, drops };
}

// ---- top-level ----
