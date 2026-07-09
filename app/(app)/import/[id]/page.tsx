import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconArrowLeft,
  IconAlertTriangle,
  IconExternalLink,
} from "@tabler/icons-react";
import {
  getMedicalDocument,
  getDocumentProduced,
  getRecordsForDocument,
  getCanonicalAutocomplete,
  getProviderNames,
} from "@/lib/queries";
import { getUserFullName } from "@/lib/settings";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { parseSortColumn, parseSortDir } from "@/lib/table-sort";
import { PageHeader } from "@/components/ui";
import ImportDetailActions from "@/components/ImportDetailActions";
import ReassignDocument from "@/components/ReassignDocument";
import ExtractedRecords from "@/components/ExtractedRecords";
import ProviderDatalist from "@/components/ProviderDatalist";
import {
  documentFormatLabel,
  isProvenanceMismatch,
  shapeProducedBreakdown,
  producedTotal,
  formatRawExtraction,
} from "@/lib/import-log";
import {
  parseImportReport,
  summarizeCoverage,
  groupDropsByReason,
  rowDropCount,
  isRowDrop,
} from "@/lib/import-report";

export const dynamic = "force-dynamic";

// The standard medical-record categories, matching the biomarkers filter; the
// category param is validated against this set before it reaches the query.
const CATEGORIES = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
] as const;

const STATUS_STYLE: Record<string, string> = {
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  processing:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  pending: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  skipped: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

function ProvenanceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-black/5 py-2 text-sm last:border-0 dark:border-white/10">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium text-slate-800 dark:text-slate-100">
        {value}
      </span>
    </div>
  );
}

// Import detail (issue #208, Phase 1): for one uploaded document — provenance,
// a "what it produced" verify breakdown (counts per kind, each linking to where
// those rows live), basic debug (error + raw extraction), and reprocess/delete.
export default function ImportDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: {
    category?: string;
    range?: string;
    q?: string;
    sort?: string;
    dir?: string;
  };
}) {
  const { profile } = requireSession();
  const id = Number(params.id);
  const doc = id ? getMedicalDocument(profile.id, id) : undefined;
  if (!doc) notFound();

  const counts = getDocumentProduced(profile.id, id);
  const produced = shapeProducedBreakdown(counts);
  const total = producedTotal(counts);
  const mismatch = isProvenanceMismatch(doc.patient_name, [
    getUserFullName(profile.id),
    profile.name,
  ]);
  const raw = formatRawExtraction(doc.raw_extraction);
  // Import DEBUGGER report (issue #208 Phase 2): what the parse DROPPED + why, and
  // which sections/resource types it did/didn't consume. Null for AI-extracted docs
  // or rows imported before this feature — the Debug cards degrade gracefully.
  const report = parseImportReport(doc.import_report);
  const coverage = report ? summarizeCoverage(report.coverage) : null;
  // The Dropped card lists candidate-ROW drops only; sections/resource types that
  // no importer consumed are shown in the Coverage card's "Present but not consumed"
  // (they're not rows). Filtering to row drops here keeps the card header count
  // (`droppedRows`) consistent with the grouped list below (F5).
  const rowDrops = report ? report.drops.filter(isRowDrop) : [];
  const dropGroups = groupDropsByReason(rowDrops);
  const droppedRows = report ? rowDropCount(report) : 0;
  // Labs that imported but carry a LOINC with no canonical mapping — a data-driven
  // "add these to LOINC_TO_CANONICAL" to-do list for maintainers. These readings
  // still imported (under their raw printed name); this is not a drop.
  const unmappedLoincs = report?.unmappedLoincs ?? [];
  const isTerminalIssue =
    doc.extraction_status === "failed" || doc.extraction_status === "skipped";
  // "Move to profile…" targets: the login's OTHER accessible profiles (admins see
  // all; members only their granted set). Shown only when there's somewhere to
  // move to (≥2 accessible profiles).
  const reassignTargets = getAccessibleProfiles()
    .filter((p) => p.id !== profile.id)
    .map((p) => ({ id: p.id, name: p.name }));

  // Extracted-records browser (folded in from the old /medical/[id] view): the
  // editable table + its SearchParams-driven category/range/q/sort filters, plus
  // the inline file preview. All reads stay profile-scoped.
  const category = CATEGORIES.includes(searchParams.category as any)
    ? searchParams.category
    : undefined;
  const range =
    searchParams.range === "oor"
      ? "oor"
      : searchParams.range === "nonoptimal"
        ? "nonoptimal"
        : undefined;
  const q = searchParams.q?.trim() || undefined;
  // Name/panel/date sort, whitelisted via the shared parser (matching the
  // biomarkers table); name is the default so the table opens grouped by name.
  const sort = parseSortColumn(
    searchParams.sort,
    ["name", "panel", "date"] as const,
    "name"
  );
  const dir = parseSortDir(searchParams.dir);
  const records = getRecordsForDocument(profile.id, id, {
    category,
    range,
    q,
    sort,
    dir,
  });
  const canonicalOptions = getCanonicalAutocomplete(profile.id);
  const src = `/medical/file/${id}`;
  const mime = doc.mime_type ?? "";
  const lower = doc.filename.toLowerCase();
  const isPdf = mime === "application/pdf" || lower.endsWith(".pdf");
  const isImage = mime.startsWith("image/");
  const canPreview = Boolean(doc.stored_path) && (isPdf || isImage);

  return (
    <div>
      {/* Shared datalist powering the canonical-name autocomplete on every edit row. */}
      <datalist id="canonical-names">
        {canonicalOptions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {/* Shared provider picker options for each record's edit row (issue #178). */}
      <ProviderDatalist names={getProviderNames()} />

      <Link
        href="/data?section=review"
        className="mb-4 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-400"
      >
        <IconArrowLeft className="h-4 w-4" /> Back to Review
      </Link>

      <PageHeader
        title={doc.filename}
        subtitle={documentFormatLabel(doc)}
        action={
          <span
            className={`badge ${STATUS_STYLE[doc.extraction_status] ?? ""}`}
          >
            {doc.extraction_status}
          </span>
        }
      />

      <div className="space-y-6">
        {/* Provenance */}
        <div className="card">
          <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
            Provenance
          </h2>
          <ProvenanceRow label="File" value={doc.filename} />
          <ProvenanceRow
            label="Detected format"
            value={documentFormatLabel(doc)}
          />
          <ProvenanceRow
            label="Document date"
            value={doc.document_date ?? "—"}
          />
          <ProvenanceRow label="Source" value={doc.source ?? "—"} />
          <ProvenanceRow
            label="Patient named in document"
            value={doc.patient_name ?? "—"}
          />
          {mismatch && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This document names <strong>{doc.patient_name}</strong>, which
                doesn’t match this profile ({profile.name}). Make sure it was
                imported under the right person.
              </span>
            </div>
          )}
        </div>

        {/* What it produced (verify) */}
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            What it produced
          </h2>
          {total === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {doc.extraction_status === "processing"
                ? "Extraction is still running…"
                : "This import produced no records."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {produced.map((row) => {
                const inner = (
                  <>
                    <span className="tabular-nums font-semibold">
                      {row.count}
                    </span>{" "}
                    {row.label}
                  </>
                );
                return row.href ? (
                  <Link
                    key={row.key}
                    href={row.href}
                    className="badge inline-flex items-center gap-1 bg-slate-100 text-slate-700 transition hover:bg-brand-100 hover:text-brand-700 dark:bg-ink-800 dark:text-slate-200 dark:hover:bg-brand-950 dark:hover:text-brand-300"
                  >
                    {inner}
                  </Link>
                ) : (
                  <span
                    key={row.key}
                    className="badge inline-flex items-center gap-1 bg-slate-100 text-slate-700 dark:bg-ink-800 dark:text-slate-200"
                  >
                    {inner}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Coverage (import debugger) */}
        {report && coverage && (
          <div className="card">
            <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
              Coverage
            </h2>
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              Considered{" "}
              <span className="tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                {report.considered}
              </span>{" "}
              · imported{" "}
              <span className="tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                {report.imported}
              </span>{" "}
              · dropped{" "}
              <span className="tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                {droppedRows}
              </span>
            </p>
            {coverage.consumed.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  Sections read
                </div>
                <div className="flex flex-wrap gap-2">
                  {coverage.consumed.map((c) => (
                    <span
                      key={c.key + c.title}
                      className="badge inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    >
                      {c.title} ✓
                    </span>
                  ))}
                </div>
              </div>
            )}
            {coverage.notConsumed.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  Present but not consumed
                </div>
                <div className="flex flex-wrap gap-2">
                  {coverage.notConsumed.map((c) => (
                    <span
                      key={c.key + c.title}
                      className="badge inline-flex items-center gap-1 bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
                    >
                      {c.title}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                  These sections were in the document but the app has no
                  importer for them yet.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Unmapped lab codes (import debugger, Fix 3): imported, but under their
            raw name because their LOINC has no canonical mapping yet. */}
        {report && unmappedLoincs.length > 0 && (
          <div className="card">
            <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
              Unmapped lab codes ({unmappedLoincs.length})
            </h2>
            <p className="mb-3 text-xs text-slate-400 dark:text-slate-500">
              These labs imported under their printed name, but their LOINC has
              no entry in the canonical map — so they don’t group with the
              matching biomarker or pick up its reference band. Add the code to{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-ink-800">
                lib/biomarker-loinc.ts
              </code>{" "}
              to canonicalize them.
            </p>
            <ul className="text-sm text-slate-600 dark:text-slate-300">
              {unmappedLoincs.map((u) => (
                <li
                  key={u.loinc}
                  className="flex flex-wrap items-baseline gap-x-2 border-b border-black/5 py-1 last:border-0 dark:border-white/10"
                >
                  <code className="rounded bg-slate-100 px-1 font-medium tabular-nums dark:bg-ink-800">
                    {u.loinc}
                  </code>
                  <span>{u.name}</span>
                  {u.count > 1 && (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      ×{u.count}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Dropped candidates (import debugger) */}
        {report && dropGroups.length > 0 && (
          <div className="card">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Dropped ({droppedRows})
            </h2>
            <p className="mb-3 text-xs text-slate-400 dark:text-slate-500">
              Itemized drops cover labs, vitals, immunizations, medications,
              allergies and problems (plus duplicates). Encounters, social
              history and some retracted resources aren’t itemized yet, and
              “imported” counts parsed rows before body-metric deferral — so
              these totals are indicative, not exhaustive.
            </p>
            <div className="space-y-4">
              {dropGroups.map((g) => (
                <div key={g.reason}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {g.label}
                    </span>
                    <span className="badge bg-slate-100 tabular-nums text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                      {g.drops.length}
                    </span>
                  </div>
                  <ul className="space-y-0.5 text-sm text-slate-600 dark:text-slate-300">
                    {g.drops.map((d, i) => (
                      <li
                        key={`${d.label}-${i}`}
                        className="flex flex-wrap items-baseline gap-x-2 border-b border-black/5 py-1 last:border-0 dark:border-white/10"
                      >
                        <span className="font-medium">{d.label}</span>
                        {d.section && (
                          <span className="text-xs text-slate-400 dark:text-slate-500">
                            {d.section}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Extracted records (editable) — folded in from the old /medical/[id] view */}
        <ExtractedRecords
          docId={id}
          filename={doc.filename}
          processing={doc.extraction_status === "processing"}
          records={records}
          q={q}
          range={range}
          category={category}
          sort={sort}
          emptyMessage={
            q || range || category
              ? "No records in this document match these filters."
              : doc.extraction_status === "processing"
                ? "Extraction is still running…"
                : "No records were extracted from this document."
          }
        />

        {/* Inline document preview */}
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Document
            </h2>
            {doc.stored_path ? (
              <a
                href={src}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-400"
              >
                Open original <IconExternalLink className="h-4 w-4" />
              </a>
            ) : null}
          </div>
          {canPreview ? (
            isPdf ? (
              <iframe
                src={src}
                title={doc.filename}
                className="h-[80vh] w-full rounded-lg border border-black/10 dark:border-white/10"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={doc.filename}
                className="mx-auto max-h-[80vh] rounded-lg border border-black/10 dark:border-white/10"
              />
            )
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Inline preview isn’t available for this file type.{" "}
              {doc.stored_path ? (
                <a
                  href={src}
                  target="_blank"
                  rel="noopener"
                  className="text-brand-700 hover:underline dark:text-brand-400"
                >
                  Open the original
                </a>
              ) : (
                "The original file is not stored."
              )}
            </p>
          )}
        </div>

        {/* Debug */}
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Debug
          </h2>
          {isTerminalIssue && doc.extraction_error ? (
            <div
              className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
                doc.extraction_status === "failed"
                  ? "border-rose-100 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
                  : "border-black/10 bg-slate-50 text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400"
              }`}
            >
              {doc.extraction_error}
            </div>
          ) : (
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              No extraction error.
            </p>
          )}
          {raw ? (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
                Raw extraction
              </summary>
              <pre className="mt-2 max-h-[60vh] overflow-auto rounded-lg border border-black/10 bg-slate-50 p-3 text-xs text-slate-700 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300">
                {raw}
              </pre>
            </details>
          ) : (
            <p className="text-sm text-slate-400 dark:text-slate-500">
              No raw extraction stored for this document.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Actions
          </h2>
          <ImportDetailActions id={doc.id} filename={doc.filename} />
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            Reprocessing previews the diff before re-running extraction and
            replacing this document’s imported records. Deleting removes the
            document and everything it imported.
          </p>
          {reassignTargets.length > 0 && (
            <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/10">
              <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                Wrong person?
              </h3>
              <p className="mb-3 text-xs text-slate-400 dark:text-slate-500">
                Move this document — and every row it imported — to another
                profile you can access.
              </p>
              {doc.extraction_status === "processing" ? (
                // A move mid-extraction would strand the in-flight import under the
                // wrong profile (the reassignDocument action refuses it too — this
                // just hides the control until it settles).
                <p className="text-sm text-slate-400 dark:text-slate-500">
                  This document is still processing — you can move it once
                  extraction finishes.
                </p>
              ) : (
                <ReassignDocument
                  id={doc.id}
                  filename={doc.filename}
                  destinations={reassignTargets}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
