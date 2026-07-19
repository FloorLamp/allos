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

// Why a candidate reading didn't make it into the imported set. A closed enum so
// the UI can group + label consistently and a stored report stays stable.
export type DropReason =
  | "null_flavor" // the value was explicitly null-flavored (e.g. <value nullFlavor="NA"/>)
  | "unmapped_loinc" // the code has no canonical mapping we understand (also unmapped CVX)
  | "placeholder_noise" // a resolved value that is a bare placeholder ("—", "N/A", …)
  | "deduped" // a duplicate of a reading already imported (same external_id)
  | "no_value" // the observation carried no productive value at all
  | "non_analyte" // an administrative/structural observation (specimen date, "Approved By", accession #) — not a measurement (#681/#693)
  | "derived_percentile" // a derived anthropometric percentile (BMI/weight-for-length/head-circ) the app recomputes itself, not a raw measurement (#684/#722/#693)
  | "negated" // a negated / retracted / entered-in-error assertion
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
  unresolvedNames?: UnresolvedName[];
  // Source-text reconciliation for an AI-extracted PDF (this branch). Absent for CCD
  // reports, non-PDF sources, and reports stored before this field.
  reconciliation?: ReconciliationSummary | null;
}

export function emptyReport(): ImportReport {
  return {
    drops: [],
    coverage: [],
    imported: 0,
    considered: 0,
    unmappedLoincs: [],
    unresolvedNames: [],
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
export function isRowDrop(d: ImportDrop): boolean {
  return d.reason !== "unrecognized_section";
}

export function rowDropCount(report: ImportReport): number {
  return report.drops.filter(isRowDrop).length;
}

// ---- reason labels ----

const REASON_LABELS: Record<DropReason, string> = {
  null_flavor: "No value (null-flavored)",
  unmapped_loinc: "Unrecognized code",
  placeholder_noise: "Placeholder / noise",
  deduped: "Duplicate (already imported)",
  no_value: "No value",
  non_analyte: "Non-analyte / administrative",
  derived_percentile: "Derived percentile (recomputed)",
  negated: "Negated / retracted",
  unrecognized_section: "Section not consumed",
  other: "Other",
};

export function reasonLabel(reason: DropReason): string {
  return REASON_LABELS[reason] ?? reason;
}

// The order reasons are shown in the grouped list — most actionable first.
const REASON_ORDER: DropReason[] = [
  "unmapped_loinc",
  "no_value",
  "null_flavor",
  "placeholder_noise",
  "non_analyte",
  "derived_percentile",
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
  return {
    drops: present.flatMap((r) => r.drops),
    coverage: present.flatMap((r) => r.coverage),
    imported: present.reduce((n, r) => n + r.imported, 0),
    considered: present.reduce((n, r) => n + r.considered, 0),
    unmappedLoincs: tallyUnmappedLoincs(
      present.flatMap((r) => r.unmappedLoincs ?? [])
    ),
    unresolvedNames: tallyUnresolvedNames(
      present.flatMap((r) => r.unresolvedNames ?? [])
    ),
    // Reconciliation is single-document (the AI path never merges); carry the first
    // present one through rather than trying to combine across documents.
    reconciliation:
      present.find((r) => r.reconciliation)?.reconciliation ?? null,
  };
}

// ---- persistence (de)serialization ----

// Serialize a report for storage on medical_documents.import_report. Null when
// there's nothing to store (keeps the column clean for AI-extracted documents).
export function serializeImportReport(
  report: ImportReport | null | undefined
): string | null {
  if (!report) return null;
  return JSON.stringify(report);
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
    const unresolvedNames = Array.isArray(obj.unresolvedNames)
      ? (obj.unresolvedNames as UnresolvedName[])
      : [];
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
      reconciliation,
    };
  } catch {
    return null;
  }
}
