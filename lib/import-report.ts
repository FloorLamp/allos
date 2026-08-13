// Pure drop-reason + coverage reporting for the deterministic health-record
// importers — the import DEBUGGER. No DB / network.
//
// The CCD/FHIR extractors silently drop candidate readings (a nullFlavor'd value,
// a placeholder "—", a "no known allergy" negation, a duplicate, an unrecognized
// section / unmapped resource type). This module holds the SHARED shapes the
// parsers populate as they drop, plus the pure derivations the /import/[id] Debug
// view renders from them: grouping drops by reason, summarizing coverage
// (consumed vs present-but-not-consumed), and merging the per-document reports an
// XDM package produces into one. Classification itself lives next to the raw
// parser nodes (lib/cda.ts, lib/fhir.ts) — that's where the reason is knowable —
// and feeds these structures.

import {
  mergeConfidenceSummaries,
  parseConfidenceSummary,
  type ExtractionConfidenceSummary,
} from "./extraction-confidence";
import { uncuratedAnalyte, type UncuratedAnalyte } from "./canonical-name";

// Why a candidate reading didn't make it into the imported set. A closed enum so
// the UI can group + label consistently and a stored report stays stable.
export type DropReason =
  | "null_flavor" // the value was explicitly null-flavored (e.g. <value nullFlavor="NA"/>)
  | "unmapped_loinc" // the code has no canonical mapping we understand (also unmapped CVX)
  | "placeholder_noise" // a resolved value that is a bare placeholder ("—", "N/A", …)
  | "unparsable_value" // the source declared a unit the value doesn't satisfy — e.g. a `min:sec` duration whose value isn't a duration (#2322); storing it would be a reading that is really a string
  | "deduped" // a duplicate of a reading already imported (same external_id)
  | "no_value" // the observation carried no productive value at all
  | "non_analyte" // an administrative/structural observation (specimen date, "Approved By", accession #) — not a measurement (#681/#693)
  | "derived_percentile" // a derived anthropometric percentile (BMI/weight-for-length/head-circ) the app recomputes itself, not a raw measurement (#684/#722/#693)
  | "derived_result" // a printed DERIVED result whose chart is a computation over inputs that arrived in the same document and are themselves projected — a BMI beside the weight and height it came from (#2646). Distinct from `derived_percentile`, which is a rank the app recomputes off growth curves: this one is the quantity itself, dropped because it has no destination row rather than because it is the wrong quantity. It is the only ingest outcome with NO artefact anywhere afterwards, which is why #2678 made it report: a drop by design still has to be visible
  | "negated" // a negated / retracted / entered-in-error assertion
  | "other_subject" // a screening instrument that could not be attributed to this chart's patient (#2321/#2558): the document says it is somebody ELSE's, or says nothing while naming more than one patient. Post-natal screening is administered to a parent and filed in the child's chart; a misattributed crisis-escalating score is worse than an unimported one. A single-patient document that restates no subject is NOT this case — nobody else is in it, so it scores
  | "incomplete_instrument" // a recognised screening instrument that is only PARTIALLY answered (#2321). A partial total is not a smaller total, it is a different measurement — it cannot be banded against cut-offs derived from the whole
  | "correction_orphaned" // a HAND CORRECTION this reprocess could not carry over (#2364) — the one reason here that is not about a candidate the document offered. A reprocess deletes and re-inserts the footprint, so a user's corrected value is captured and re-applied by identity (lib/import-corrections.ts); when the new extraction produces no counterpart, the correction has lost its subject. Reported rather than resurrected: putting the row back would keep something the document stopped claiming, and dropping it in silence is the defect
  | "unrecognized_section" // a whole section / resource type no extractor consumes
  | "other"; // anything else (e.g. no usable date)

// What kind of candidate was dropped — drives the label + grouping icon.
export type DropKind =
  | "lab"
  | "vitals"
  | "immunization"
  | "medication"
  | "allergy"
  | "condition"
  | "encounter"
  | "procedure"
  | "family_history"
  | "care_plan"
  | "care_goal"
  | "appointment"
  | "genomic_variant"
  | "imaging_study"
  | "optical_prescription"
  | "dental_procedure"
  | "section" // a whole CDA section
  | "resource"; // a whole FHIR resource type

// One dropped candidate: what it was, and why it didn't import.
export interface ImportDrop {
  kind: DropKind;
  label: string; // the reading's name / code, the section title, or the resource type
  reason: DropReason;
  section?: string; // the originating section title / resource type (context)
}

// A lab/observation code that imported CORRECTLY but under its raw printed name
// because its LOINC has no entry in LOINC_TO_CANONICAL (and it isn't a vital). This
// is NOT a drop — the reading is kept — it's a "we imported this but couldn't
// canonicalize / group / reference-band it" annotation so a maintainer can see
// exactly which codes to add to LOINC_TO_CANONICAL. `count` is how many readings in
// the document carried this code.
export interface UnmappedLoinc {
  loinc: string;
  name: string; // the printed / display name the reading imported under
  count: number;
  // The unit the readings carried (catalog identity, like the code and name — NOT
  // the user's measured value). Optional: reports stored before this field, and
  // unit-less readings, leave it unset. Used by the "Report unmapped code" prefill.
  unit?: string | null;
}

// The AI path's analogue of UnmappedLoinc (#918 §4). It has no LOINC to fall back
// on — identity comes from the model's name alone — so when a lab reading's
// canonical name matches no curated dataset entry it imports under that raw name
// with NO reference band and never flags, exactly like an unmapped LOINC, but
// SILENTLY: the CCD path reports its equivalent gap, the AI path reported nothing.
// This surfaces it so the miss is self-reporting (add an alias or curate the entry)
// instead of needing an audit. `count` is how many readings carried the name.
export interface UnresolvedName {
  name: string; // the canonical name the reading imported under (matched no entry)
  count: number;
  // The unit the readings carried (catalog identity, NOT the measured value).
  // Optional: unit-less readings leave it unset. Used by the "Report" prefill.
  unit?: string | null;
}

// An unresolved name the repo has DECLARED it doesn't curate (#2313) — same row,
// carrying the declaration that says so. Never a to-do: it is the analyte world's
// `not-applicable`, and the surfaces that render it must not offer the "report
// this" action that only makes sense for a genuine gap.
export interface DeclinedName extends UnresolvedName {
  declaration: UncuratedAnalyte;
}

// Partition an unresolved-name tally into the genuinely-unknown names and the
// declared ones, against the CURRENT registry. Pure and order-preserving; the
// only place either side of the split is decided.
export function splitDeclaredNames(names: readonly UnresolvedName[]): {
  unresolvedNames: UnresolvedName[];
  declinedNames: DeclinedName[];
} {
  const unresolvedNames: UnresolvedName[] = [];
  const declinedNames: DeclinedName[] = [];
  for (const n of names) {
    const declaration = uncuratedAnalyte(n.name);
    if (declaration) declinedNames.push({ ...n, declaration });
    else unresolvedNames.push(n);
  }
  return { unresolvedNames, declinedNames };
}

// One extracted row that the source PDF's own text could NOT corroborate — the AI
// path cross-checked against the report's text/OCR (lib/medical-extract/reconcile)
// and this row's value wasn't found next to its name (value_mismatch), or the name
// never appeared at all (name_not_found). A review flag, not a proven error.
export interface ReconciliationFlag {
  name: string;
  value: string | null;
  verdict: "value_mismatch" | "name_not_found";
}

// Whole-document reconciliation outcome for an AI-extracted PDF: how many rows the
// source text confirmed, and the ones it didn't. Absent for non-PDF sources and for
// a scan whose OCR yielded no usable text (nothing to check against).
export interface ReconciliationSummary {
  confirmed: number;
  total: number;
  flags: ReconciliationFlag[];
}

// One section (CDA) or resource type (FHIR) the document contained, and whether
// the app actually consumed it into a sink. `present` is how many entries /
// resources it held.
export interface CoverageEntry {
  key: string; // catalog key (CDA extractor key / friendly slug) or FHIR resourceType
  title: string; // human title
  consumed: boolean; // did an extractor / mapper route this to a stored sink?
  present: number; // entries / resources present
  // Recognized but DELIBERATELY not imported (#268 — Insurance/Payers): the
  // section is a known, intentionally-out-of-scope type, so it's neither a
  // consumed sink nor an unrecognized gap. Optional so stored reports from before
  // this field (where it was simply not-consumed) parse unchanged.
  ignored?: boolean;
}

// The full per-document report persisted on medical_documents.import_report.
export interface ImportReport {
  drops: ImportDrop[];
  coverage: CoverageEntry[];
  // Kept-vs-considered counts: `imported` rows survived; `considered` is
  // imported + the row-level drops (section/resource-level "not consumed" entries
  // are NOT candidate rows and don't count toward considered).
  //
  // On a STORED report both are the post-persist footprint tally, not the parse's
  // own guess (#1827): persistDocumentImport rebinds them through
  // withFootprintCounts in the same UPDATE that writes `extracted_count`, so the
  // coverage card's "imported" and the document's extracted count are the same
  // number. A report held in memory before persist carries the parse-time estimate
  // (keptRowCount).
  imported: number;
  considered: number;
  // Lab/observation LOINCs that imported but carry NO canonical mapping (Fix 3) —
  // a non-fatal "add these to LOINC_TO_CANONICAL" annotation, surfaced in the
  // debugger. Optional so reports stored before this field (and the AI path) stay
  // valid; parseImportReport defaults it to [].
  unmappedLoincs?: UnmappedLoinc[];
  // Lab readings whose canonical NAME matched no curated entry (#918 §4) — the AI
  // path's parallel to unmappedLoincs (it has no LOINC). Optional so reports stored
  // before this field, and every CCD report, stay valid; parseImportReport defaults
  // it to [].
  //
  // On a PARSED report this holds only the genuinely-unknown names: the ones the
  // repo has declared it doesn't curate are split out into `declinedNames` below.
  unresolvedNames?: UnresolvedName[];
  // The declared half of that split (#2313) — READ-time only. It is never stored:
  // serializeImportReport folds it back into `unresolvedNames`, because the split
  // is a view over the CURRENT registry and a stored report must not freeze today's
  // answer. Optional for the same reason the field above is.
  declinedNames?: DeclinedName[];
  // Source-text reconciliation for an AI-extracted PDF (this branch). Absent for CCD
  // reports, non-PDF sources, and reports stored before this field.
  reconciliation?: ReconciliationSummary | null;
  // Per-record extraction confidence (#1601): how the model's own certainty split
  // across this document's rows, plus the rows it hedged on, lowest first. THIS is
  // where confidence is persisted — on the document's report, beside the other
  // review signals — so no per-row schema column is involved and the signal lives
  // and dies with the document it describes (a reassign moves it, a delete removes
  // it, a reprocess rewrites it). Null/absent for every path with no model answer:
  // a deterministic CCD/FHIR import, an offline/keyless extraction, and any document
  // imported before this field existed. See lib/extraction-confidence.ts.
  confidence?: ExtractionConfidenceSummary | null;
}

export function emptyReport(): ImportReport {
  return {
    drops: [],
    coverage: [],
    imported: 0,
    considered: 0,
    unmappedLoincs: [],
    unresolvedNames: [],
    declinedNames: [],
  };
}

// Tally a flat list of unmapped-LOINC observations into per-code counts, sorted
// most-frequent first (then LOINC, for a stable display) — so "map the top-N
// unmapped codes" reads straight off the list. Used both by the parsers (each
// reading counts once) and by mergeReports (summing the per-document tallies).
export function tallyUnmappedLoincs(
  items: {
    loinc: string | null | undefined;
    name: string;
    count?: number;
    unit?: string | null;
  }[]
): UnmappedLoinc[] {
  const byLoinc = new Map<string, UnmappedLoinc>();
  for (const it of items) {
    if (!it.loinc) continue;
    const prev = byLoinc.get(it.loinc);
    if (prev) {
      prev.count += it.count ?? 1;
      // Keep the first unit seen for the code (a code's unit is stable in practice).
      if (prev.unit == null && it.unit != null) prev.unit = it.unit;
    } else
      byLoinc.set(it.loinc, {
        loinc: it.loinc,
        name: it.name,
        count: it.count ?? 1,
        unit: it.unit ?? null,
      });
  }
  return [...byLoinc.values()].sort(
    (a, b) => b.count - a.count || a.loinc.localeCompare(b.loinc)
  );
}

// Tally unresolved canonical names into per-name counts, sorted most-frequent first
// (then name, for a stable display). Keyed case-insensitively so "PROTEIN" and
// "Protein" fold together; the first-seen display spelling is kept. Used by the AI
// import-shape adapter (each reading counts once) and by mergeReports.
export function tallyUnresolvedNames(
  items: { name: string; count?: number; unit?: string | null }[]
): UnresolvedName[] {
  const byName = new Map<string, UnresolvedName>();
  for (const it of items) {
    const key = it.name.trim().toLowerCase();
    if (!key) continue;
    const prev = byName.get(key);
    if (prev) {
      prev.count += it.count ?? 1;
      if (prev.unit == null && it.unit != null) prev.unit = it.unit;
    } else
      byName.set(key, {
        name: it.name,
        count: it.count ?? 1,
        unit: it.unit ?? null,
      });
  }
  return [...byName.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  );
}

// ---- "Report unmapped code" prefill (#270) ----

// The public repo's new-issue endpoint the "Report unmapped code" action opens.
const NEW_ISSUE_URL = "https://github.com/FloorLamp/allos/issues/new";

// Build the prefilled GitHub new-issue URL for one unmapped code.
//
// PHI GUARD (hard requirement, #270): the prefill contains ONLY the LOINC code,
// the analyte display name, and the unit — catalog identity, the same fields the
// public LOINC database publishes. It must NEVER include measured values, dates,
// reference ranges, or provider/patient strings: the URL opens a PUBLIC GitHub
// issue. The parameter type is deliberately narrowed to exactly those three
// fields, and lib/__tests__/import-report.test.ts pins the emitted field set.
export function unmappedCodeIssueUrl(u: {
  loinc: string;
  name: string;
  unit?: string | null;
}): string {
  const title = `Unmapped LOINC ${u.loinc}: ${u.name}`;
  const body = [
    "A health-record import surfaced a lab code with no canonical mapping, so its readings don't group with a canonical biomarker or pick up its reference band.",
    "",
    `- LOINC: \`${u.loinc}\``,
    `- Display name: ${u.name}`,
    `- Unit: ${u.unit ? `\`${u.unit}\`` : "(none carried)"}`,
    "",
    "Please consider adding this code to the canonical biomarker map (`scripts/gen-canonical-biomarkers.ts` / `lib/biomarker-loinc.ts`).",
  ].join("\n");
  return `${NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// Build the prefilled GitHub new-issue URL for one unresolved canonical name (the
// AI path's analogue of unmappedCodeIssueUrl, #918 §4).
//
// PHI GUARD (hard requirement, same as #270): the prefill contains ONLY the analyte
// display name and unit — catalog identity, no patient specifics. It must NEVER
// include measured values, dates, reference ranges, or provider/patient strings:
// the URL opens a PUBLIC GitHub issue. The parameter type is narrowed to exactly
// those two fields, and import-report.test.ts pins the emitted field set.
export function unresolvedNameIssueUrl(u: {
  name: string;
  unit?: string | null;
}): string {
  const title = `Unresolved analyte: ${u.name}`;
  const body = [
    "An AI-extracted health record surfaced a lab analyte whose name matched no canonical biomarker, so its readings don't group with a canonical biomarker or pick up its reference band. (The AI path has no LOINC to fall back on — identity is the name alone.)",
    "",
    `- Analyte name: ${u.name}`,
    `- Unit: ${u.unit ? `\`${u.unit}\`` : "(none carried)"}`,
    "",
    "Please consider adding an alias (`lib/canonical-name.ts` `CANONICAL_ALIASES`) if this is a known analyte named differently, or curating a new entry (`lib/curated-biomarkers.ts`) if it isn't modeled yet.",
  ].join("\n");
  return `${NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// ---- drop counting ----

// A row-level drop is a dropped candidate READING (not a whole unrecognized
// section / resource type). These are what `considered - imported` counts.
//
// `correction_orphaned` is excluded for a DIFFERENT reason than
// `unrecognized_section` (#2364): it is not a candidate the document offered at all,
// it is a user's own correction that lost its subject. Counting it would inflate
// "how many readings did this parse consider" with something the parse never saw.
export function isRowDrop(d: ImportDrop): boolean {
  return (
    d.reason !== "unrecognized_section" && d.reason !== "correction_orphaned"
  );
}

export function rowDropCount(report: ImportReport): number {
  return report.drops.filter(isRowDrop).length;
}

// ---- kept-row counting (parse time) ----

// THE registry of row-bearing kept lists a parse produces (#1827). Every parse-time
// report builder — the CCD single-document path, the CCD/XDM merge, the FHIR bundle
// mapper, and the AI extraction adapter — counts its kept rows through this ONE
// list, so a new clinical domain lands in exactly one place. Each builder used to
// carry its own hand-maintained sum instead, and the four had drifted from each
// other and from the truth: the CCD copies summed nine terms and silently omitted
// the imaging studies they were already keeping.
//
// A parse-time count is an ESTIMATE, not the answer. Whether a kept candidate
// becomes a stored row is a PERSIST-time decision (a prescription that renews an
// existing medication attaches as a course instead of a new item; a body metric
// defers to a date another source already covers), so the authoritative number is
// the post-persist footprint tally that also writes `extracted_count`.
// persistDocumentImport rebinds the stored report's counts onto it — see
// withFootprintCounts.
const KEPT_ROW_LISTS = [
  "records",
  "immunizations",
  "allergies",
  "conditions",
  "encounters",
  "procedures",
  "familyHistory",
  "carePlanItems",
  "careGoals",
  "appointments",
  "genomicVariants",
  "imagingStudies",
  "opticalPrescriptions",
  "dentalProcedures",
  "bodyMetrics",
  "heights",
  "headCircs",
  "waistCircs",
] as const;

// Structural, so both the parse-layer ImportResult and the persist-layer
// PersistInput satisfy it without either shape importing the other. Every list is
// optional: a parser that doesn't produce a domain simply omits it.
export type KeptRowLists = {
  [K in (typeof KEPT_ROW_LISTS)[number]]?: readonly unknown[] | null;
};

export function keptRowCount(lists: KeptRowLists): number {
  let total = 0;
  for (const key of KEPT_ROW_LISTS) total += lists[key]?.length ?? 0;
  return total;
}

// ---- footprint reconciliation (persist time) ----

// Rebind a report's kept-vs-considered counts to the authoritative post-persist
// footprint tally (#1827): `imported` IS the number of rows the import actually
// wrote (the same tally stamped into `extracted_count`, off the ONE
// IMPORT_FOOTPRINT_TABLES registry), and `considered` follows it as
// footprint + row drops. One question — "how many rows did this import keep?" —
// answered once, so the coverage card and the document's extracted count cannot
// disagree the way they did when the parse layer owned a count it couldn't verify.
export function withFootprintCounts(
  report: ImportReport,
  footprint: number
): ImportReport {
  return {
    ...report,
    imported: footprint,
    considered: footprint + rowDropCount(report),
  };
}

// The stored-string form persistDocumentImport uses, applied in the SAME UPDATE
// that writes `extracted_count`. A report-less path (AI extraction before #918's
// adapter, any parser producing none) passes null and stores null; an unparseable
// blob is left exactly as it came rather than being rewritten or dropped — the
// debugger already ignores it, and persist is not the place to destroy input.
//
// `persistDrops` are drops only the PERSIST step can know (#2364: a hand correction
// this reprocess had no counterpart to re-apply to). They are appended rather than
// re-derived, and they do not move `considered` — `isRowDrop` excludes them, because
// a lost correction was never a candidate the parse offered.
//
// The one place a report is SYNTHESIZED: when there is no stored report at all but a
// correction was orphaned, an empty report is minted to carry it. Losing a user's
// correction in silence because the parser happened to emit no debug report would be
// the same defect one level up. An UNPARSEABLE blob still passes through untouched —
// that rule is about not destroying input, and it stands.
export function reconcileStoredReportCounts(
  raw: string | null,
  footprint: number,
  persistDrops: readonly ImportDrop[] = []
): string | null {
  const parsed = parseImportReport(raw);
  const report =
    parsed ?? (raw === null && persistDrops.length ? emptyReport() : null);
  if (!report) return raw;
  const withDrops = persistDrops.length
    ? { ...report, drops: [...report.drops, ...persistDrops] }
    : report;
  return serializeImportReport(withFootprintCounts(withDrops, footprint));
}

// ---- reason labels ----

const REASON_LABELS: Record<DropReason, string> = {
  correction_orphaned: "Your correction has no matching reading",
  null_flavor: "No value (null-flavored)",
  unmapped_loinc: "Unrecognized code",
  placeholder_noise: "Placeholder / noise",
  unparsable_value: "Unparsable value",
  deduped: "Duplicate (already imported)",
  no_value: "No value",
  non_analyte: "Non-analyte / administrative",
  derived_percentile: "Derived percentile (recomputed)",
  derived_result: "Derived result (charted from its inputs)",
  negated: "Negated / retracted",
  // Not "for another subject": that is only half of what lands here since #2558, and
  // the other half is a screening the document declined to attribute at all.
  other_subject: "Screening not attributable to this patient",
  incomplete_instrument: "Screening only partly answered",
  unrecognized_section: "Section not consumed",
  other: "Other",
};

export function reasonLabel(reason: DropReason): string {
  return REASON_LABELS[reason] ?? reason;
}

// The order reasons are shown in the grouped list — most actionable first.
const REASON_ORDER: DropReason[] = [
  // First: it is the only reason here that describes something the USER did and
  // this import could not keep, so it outranks every parser-side refusal.
  "correction_orphaned",
  "unmapped_loinc",
  "no_value",
  "null_flavor",
  "placeholder_noise",
  "unparsable_value",
  "non_analyte",
  "derived_percentile",
  "derived_result",
  "incomplete_instrument",
  "other_subject",
  "negated",
  "deduped",
  "unrecognized_section",
  "other",
];

// One group of drops sharing a reason, for the "Dropped (K)" list.
export interface DropGroup {
  reason: DropReason;
  label: string;
  drops: ImportDrop[];
}

// Group a report's drops by reason, ordered by REASON_ORDER, each group's drops
// kept in their original order. Empty groups are omitted.
export function groupDropsByReason(drops: ImportDrop[]): DropGroup[] {
  const byReason = new Map<DropReason, ImportDrop[]>();
  for (const d of drops) {
    const arr = byReason.get(d.reason);
    if (arr) arr.push(d);
    else byReason.set(d.reason, [d]);
  }
  const groups: DropGroup[] = [];
  for (const reason of REASON_ORDER) {
    const arr = byReason.get(reason);
    if (arr && arr.length) {
      groups.push({ reason, label: reasonLabel(reason), drops: arr });
    }
  }
  // Any reason not in REASON_ORDER (future-proofing) appended at the end.
  for (const [reason, arr] of byReason) {
    if (!REASON_ORDER.includes(reason) && arr.length) {
      groups.push({ reason, label: reasonLabel(reason), drops: arr });
    }
  }
  return groups;
}

// One collapsed row in the Dropped list: every drop in a reason-group sharing the
// same (label, section) folded into a single row with a ×count (#270 — a
// real-world CCD produces hundreds of near-identical drops, e.g. the same
// null-flavored "Comment(s)" row once per panel).
export interface CollapsedDrop {
  kind: DropKind;
  label: string;
  section?: string;
  count: number;
}

// Collapse a reason-group's drops per (label, section), preserving first-seen
// order. `kind` follows the first occurrence (drops sharing a label+section within
// one reason are the same candidate shape in practice). The counts sum back to
// drops.length, so the group-header badge can keep showing the true total.
export function collapseDrops(drops: ImportDrop[]): CollapsedDrop[] {
  const byKey = new Map<string, CollapsedDrop>();
  for (const d of drops) {
    // \u0000 can't occur in a label/section, so the key can't collide across fields.
    const key = `${d.label}\u0000${d.section ?? ""}`;
    const prev = byKey.get(key);
    if (prev) prev.count += 1;
    else
      byKey.set(key, {
        kind: d.kind,
        label: d.label,
        section: d.section,
        count: 1,
      });
  }
  return [...byKey.values()];
}

// ---- coverage summary ----

export interface CoverageSummary {
  consumed: CoverageEntry[]; // sections/types the app read into a sink
  // Recognized but deliberately not imported (#268 — e.g. Insurance/Payers):
  // known types the app chooses not to store, so they don't read as a gap.
  ignored: CoverageEntry[];
  notConsumed: CoverageEntry[]; // present in the document but nothing consumed them
}

// Split coverage into consumed vs recognized-but-ignored vs
// present-but-not-consumed, each de-duplicated by title (an XDM package's merged
// report can list a section from several documents) and sorted by title for a
// stable display.
export function summarizeCoverage(coverage: CoverageEntry[]): CoverageSummary {
  const byTitle = new Map<string, CoverageEntry>();
  for (const c of coverage) {
    const key = c.title.toLowerCase();
    const prev = byTitle.get(key);
    if (!prev) {
      byTitle.set(key, { ...c });
    } else {
      // OR consumed (and ignored) together; keep the max present count.
      prev.consumed = prev.consumed || c.consumed;
      prev.ignored = prev.ignored || c.ignored;
      prev.present = Math.max(prev.present, c.present);
    }
  }
  const all = [...byTitle.values()].sort((a, b) =>
    a.title.localeCompare(b.title)
  );
  return {
    consumed: all.filter((c) => c.consumed),
    // Consumed wins over ignored (a section one document consumed and another
    // flagged ignored is still a read section).
    ignored: all.filter((c) => !c.consumed && c.ignored),
    notConsumed: all.filter((c) => !c.consumed && !c.ignored),
  };
}

// ---- merge (XDM multi-document) ----

// Merge several per-document reports (one per ClinicalDocument in an XDM package)
// into one: drops concatenate, coverage unions by title (see summarizeCoverage's
// dedup), and the counts sum. Cross-document dedupe drops are added by the caller
// (mergeImportResults) since they're only knowable across documents.
export function mergeReports(
  reports: (ImportReport | undefined)[]
): ImportReport {
  const present = reports.filter((r): r is ImportReport => r != null);
  if (present.length === 0) return emptyReport();
  // Unresolved names merge as ONE pool and re-split (#2313): a merged package's
  // declared/undeclared partition is decided by the registry, not by which half of
  // which document's report a name happened to be sitting in.
  const names = splitDeclaredNames(
    tallyUnresolvedNames(
      present.flatMap((r) => [
        ...(r.unresolvedNames ?? []),
        ...(r.declinedNames ?? []),
      ])
    )
  );
  return {
    drops: present.flatMap((r) => r.drops),
    coverage: present.flatMap((r) => r.coverage),
    imported: present.reduce((n, r) => n + r.imported, 0),
    considered: present.reduce((n, r) => n + r.considered, 0),
    unmappedLoincs: tallyUnmappedLoincs(
      present.flatMap((r) => r.unmappedLoincs ?? [])
    ),
    unresolvedNames: names.unresolvedNames,
    declinedNames: names.declinedNames,
    // Reconciliation is single-document (the AI path never merges); carry the first
    // present one through rather than trying to combine across documents.
    reconciliation:
      present.find((r) => r.reconciliation)?.reconciliation ?? null,
    // Confidence DOES combine: counts add and the flag lists concatenate + re-rank,
    // so a merged package can't silently lose one document's hedged rows.
    confidence: mergeConfidenceSummaries(present.map((r) => r.confidence)),
  };
}

// ---- persistence (de)serialization ----

// Serialize a report for storage on medical_documents.import_report. Null when
// there's nothing to store (keeps the column clean for AI-extracted documents).
export function serializeImportReport(
  report: ImportReport | null | undefined
): string | null {
  if (!report) return null;
  // The declined split (#2313) is a READ-time view over the current registry, so
  // storage keeps the whole unresolved set exactly as it always did: fold the
  // declared half back in. Otherwise a persist that round-trips a parsed report
  // (reconcileStoredReportCounts) would freeze today's registry into the blob, and
  // a name declared LATER would still read as unresolved on every old document —
  // losing the retroactivity that is the whole reason the split is at read time.
  const { declinedNames, ...rest } = report;
  if (!declinedNames?.length) return JSON.stringify(rest);
  return JSON.stringify({
    ...rest,
    // The tally rebuilds each row from name/count/unit, so the declaration — which
    // is derived, not data — is dropped rather than stored.
    unresolvedNames: tallyUnresolvedNames([
      ...(rest.unresolvedNames ?? []),
      ...declinedNames,
    ]),
  });
}

// Parse a stored import_report JSON string back into a report, tolerating null /
// malformed input (returns null) so the detail view degrades gracefully for
// documents imported before this column existed or via a path that doesn't
// produce a report (AI extraction).
export function parseImportReport(raw: string | null): ImportReport | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object") return null;
    const drops = Array.isArray(obj.drops) ? (obj.drops as ImportDrop[]) : [];
    const coverage = Array.isArray(obj.coverage)
      ? (obj.coverage as CoverageEntry[])
      : [];
    const imported = typeof obj.imported === "number" ? obj.imported : 0;
    const considered =
      typeof obj.considered === "number" ? obj.considered : imported;
    const unmappedLoincs = Array.isArray(obj.unmappedLoincs)
      ? (obj.unmappedLoincs as UnmappedLoinc[])
      : [];
    // The declared/unresolved split happens HERE, on READ, against the current
    // registry (#2313) — never at write time. That is what makes a new declaration
    // retroactive: every already-stored report splits correctly the moment the
    // declaration ships, with no migration and nothing to reprocess. `declinedNames`
    // is read back too (nothing writes it today — serializeImportReport folds it
    // away — but a blob that carries one must not lose the name), and the whole pool
    // is re-partitioned rather than trusted.
    const storedNames = [
      ...(Array.isArray(obj.unresolvedNames)
        ? (obj.unresolvedNames as UnresolvedName[])
        : []),
      ...(Array.isArray(obj.declinedNames)
        ? (obj.declinedNames as UnresolvedName[])
        : []),
    ];
    const { unresolvedNames, declinedNames } = splitDeclaredNames(storedNames);
    const reconciliation =
      obj.reconciliation &&
      typeof obj.reconciliation === "object" &&
      Array.isArray(obj.reconciliation.flags)
        ? (obj.reconciliation as ReconciliationSummary)
        : null;
    return {
      drops,
      coverage,
      imported,
      considered,
      unmappedLoincs,
      unresolvedNames,
      declinedNames,
      reconciliation,
      // Per-record confidence (#1601). Its own tolerant parser: a legacy report has
      // no such key, and a garbled one must degrade to "no signal" rather than break
      // the review surfaces the rest of this report feeds.
      confidence: parseConfidenceSummary(obj.confidence),
    };
  } catch {
    return null;
  }
}
