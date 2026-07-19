// Pure logic for the unified import log + import detail.
//
// The /import page interleaves two record kinds — uploaded medical_documents and
// pasted/CSV import_jobs — into one newest-first log, badges each by a normalized
// status, flags a document whose named patient doesn't match the active profile,
// and shapes the "what this import produced" row breakdown. All of it is pure
// (no DB/network), so the DB reads (lib/queries/imports.ts) stay thin and this
// logic is unit-tested in lib/__tests__/import-log.test.ts.

// The five statuses the log badges. `partial` is a paste/CSV job whose extraction
// finished but is still awaiting the user's review/save (it produced nothing yet);
// `processing` is an in-flight extraction (a document or a job); the rest mirror
// the underlying row's own status.
export type ImportLogStatus =
  "processing" | "partial" | "done" | "failed" | "skipped";

// Normalize a medical_documents.extraction_status
// (pending|processing|done|failed|skipped) into a log status. `pending` (a row
// reserved before extraction starts) reads as processing.
export function documentLogStatus(extractionStatus: string): ImportLogStatus {
  switch (extractionStatus) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "pending":
    case "processing":
    default:
      return "processing";
  }
}

// Normalize an import_jobs.status (processing|ready|failed|skipped, plus the
// transient in-flight 'committing') into a log status. A 'ready' job has been
// extracted but not yet committed, so it reads as `partial` (needs review).
export function jobLogStatus(status: string): ImportLogStatus {
  switch (status) {
    case "ready":
      return "partial";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "processing":
    case "committing":
    default:
      return "processing";
  }
}

// A color token for the status badge; the component maps the token to classes so
// the light/dark palette lives in one place (and stays out of this pure module).
export type BadgeTone = "green" | "amber" | "rose" | "slate";

export interface StatusBadge {
  label: string;
  tone: BadgeTone;
}

export function statusBadge(status: ImportLogStatus): StatusBadge {
  switch (status) {
    case "done":
      return { label: "done", tone: "green" };
    case "partial":
      return { label: "partial", tone: "amber" };
    case "processing":
      return { label: "processing", tone: "amber" };
    case "failed":
      return { label: "failed", tone: "rose" };
    case "skipped":
      return { label: "skipped", tone: "slate" };
  }
}

// ---- Format / kind labels ----

// A human label for a document's detected format/type: prefer the extracted
// doc_type, else the source (lab/provider), else the file extension, else a
// generic fallback. Purely presentational.
export function documentFormatLabel(doc: {
  doc_type: string | null;
  source: string | null;
  filename: string;
}): string {
  if (doc.doc_type && doc.doc_type.trim()) return doc.doc_type.trim();
  if (doc.source && doc.source.trim()) return doc.source.trim();
  const dot = doc.filename.lastIndexOf(".");
  if (dot > 0 && dot < doc.filename.length - 1)
    return doc.filename.slice(dot + 1).toUpperCase();
  return "Document";
}

// A human title + format label for a paste/CSV job (type is 'workouts' or
// 'biomarkers').
export function jobTitle(type: string): string {
  if (type === "workouts") return "Pasted workouts";
  if (type === "biomarkers") return "Pasted labs";
  return "Pasted import";
}

export function jobFormatLabel(type: string): string {
  if (type === "workouts") return "Workouts (paste/CSV)";
  if (type === "biomarkers") return "Biomarkers (paste/CSV)";
  return "Paste/CSV";
}

// ---- Provenance (patient-name vs active profile) ----

// Break a person name into comparable lowercase alphanumeric tokens of length ≥2,
// dropping punctuation and single-letter middle initials. "John A. Smith" →
// ["john", "smith"].
function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// Whether a document's stated patient name doesn't match the active profile.
// Flags only when the document names a patient AND we have at least one known
// name to compare against AND the two share NO name token — deliberately lenient
// (a shared surname or given name counts as a match) so a middle initial or
// name-order difference never raises a false "wrong person" alarm.
export function isProvenanceMismatch(
  patientName: string | null | undefined,
  knownNames: (string | null | undefined)[]
): boolean {
  const patient = nameTokens(patientName);
  if (patient.length === 0) return false;
  const known = new Set(knownNames.flatMap(nameTokens));
  if (known.size === 0) return false; // no basis to compare — don't cry wolf
  return !patient.some((t) => known.has(t));
}

// ---- Interleave (the unified, newest-first log) ----

// Sort mixed document + job entries newest-first by their `sortTime`
// (uploaded_at / created_at, both "YYYY-MM-DD HH:MM:SS" strings that compare
// lexicographically), tie-breaking documents before jobs and then by descending
// id, so the order is stable and deterministic.
export function interleaveImportLog<
  T extends { sortTime: string; kind: "document" | "job"; id: number },
>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.sortTime !== b.sortTime) return a.sortTime < b.sortTime ? 1 : -1;
    if (a.kind !== b.kind) return a.kind === "document" ? -1 : 1;
    return b.id - a.id;
  });
}

// ---- "What it produced" counts ----

// Raw per-kind counts a document import produced (from lib/queries/imports.ts).
// One field per IMPORT_FOOTPRINT_TABLES entry (lib/import-footprint.ts) — the same
// footprint extracted_count totals (#212) — plus the provider-reference count. The
// field↔footprint agreement is bound by lib/__tests__/import-produced-counts.test.ts
// (a table added to the footprint without a count field fails there).
// The tabbed records browser (lib/import-browser.ts) turns this into its tab
// strip, so the tab counts and the toast/Review-feed tally share one source.
export interface DocumentProducedCounts {
  // medical_records grouped by their `category` column.
  recordsByCategory: { category: string; count: number }[];
  immunizations: number;
  allergies: number;
  conditions: number;
  encounters: number;
  procedures: number;
  familyHistory: number;
  carePlanItems: number;
  careGoals: number;
  genomicVariants: number;
  imagingStudies: number;
  dentalProcedures: number;
  appointments: number;
  medications: number;
  bodyMetrics: number;
  heightSamples: number;
  headCircSamples: number;
  // Distinct providers referenced by this document's rows (global registry).
  providers: number;
}

// Sum of everything an import produced, so the detail view can show an empty
// state when an import created no rows (e.g. a failed extraction). Providers are
// deliberately excluded — they're global-registry references, not per-profile
// rows, and are likewise excluded from extracted_count (#212). This must agree
// with the stored extracted_count for a freshly-persisted document (pinned by a
// DB-tier test against countImportedDocumentRows).
export function producedTotal(counts: DocumentProducedCounts): number {
  return (
    counts.recordsByCategory.reduce((n, r) => n + r.count, 0) +
    counts.immunizations +
    counts.allergies +
    counts.conditions +
    counts.encounters +
    counts.procedures +
    counts.familyHistory +
    counts.carePlanItems +
    counts.careGoals +
    counts.genomicVariants +
    counts.imagingStudies +
    counts.dentalProcedures +
    counts.appointments +
    counts.medications +
    counts.bodyMetrics +
    counts.heightSamples +
    counts.headCircSamples
  );
}

// Pretty-print a document's stored raw_extraction for the debug view: parse-and-
// reindent when it's JSON, else return the text as-is, and cap the length so a
// huge blob can't blow up the page (the tail is elided with a marker).
const RAW_MAX_CHARS = 50_000;

export function formatRawExtraction(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let out = trimmed;
  try {
    out = JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    // Not JSON — show the raw text.
  }
  if (out.length > RAW_MAX_CHARS) {
    return `${out.slice(0, RAW_MAX_CHARS)}\n… (${out.length - RAW_MAX_CHARS} more characters truncated)`;
  }
  return out;
}
