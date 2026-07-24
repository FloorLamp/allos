import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft, IconExternalLink } from "@tabler/icons-react";
import {
  getMedicalDocument,
  getDocumentProduced,
  getRecordsForDocument,
  getCanonicalAutocomplete,
  getProviderNames,
  getDocumentVisits,
  getDocumentConditions,
  getDocumentAllergies,
  getDocumentImmunizations,
  getDocumentProcedures,
  getDocumentFamilyHistory,
  getDocumentCarePlanItems,
  getDocumentCareGoals,
  getDocumentGenomicVariants,
  getDocumentImagingStudies,
  getDocumentOpticalPrescriptions,
  getDocumentDentalProcedures,
  getDocumentAppointments,
  getDocumentMedications,
  getDocumentBodyRows,
  getDocumentProviders,
  createVisitOffers,
} from "@/lib/queries";
import { getUserFullName, getUnitPrefs } from "@/lib/settings";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { parseSortColumn, parseSortDir } from "@/lib/table-sort";
import { PageHeader } from "@/components/ui";
import { Notice } from "@/components/Notice";
import ImportDetailActions from "@/components/ImportDetailActions";
import RawDataViewer from "@/components/RawDataViewer";
import DocumentPreview from "@/components/DocumentPreview";
import ReassignDocument from "@/components/ReassignDocument";
import ExtractedRecords from "@/components/ExtractedRecords";
import CreateVisitFromRecord from "@/components/visit-links/CreateVisitFromRecord";
import ImportTabStrip from "@/components/ImportTabStrip";
import ProducedListing from "@/components/ProducedListing";
import ProducedProviders from "@/components/ProducedProviders";
import ProviderDatalist from "@/components/ProviderDatalist";
import {
  documentFormatLabel,
  isProvenanceMismatch,
  producedTotal,
  formatRawExtraction,
} from "@/lib/import-log";
import {
  reconcileProduced,
  detailReconciliationLine,
} from "@/lib/produced-count";
import { importActionExplainers } from "@/lib/import-actions-copy";
import { isDeterministicReprocess } from "@/lib/reprocess-cost";
import {
  buildImportTabs,
  resolveImportTab,
  visitItem,
  conditionItem,
  allergyItem,
  immunizationItem,
  procedureItem,
  familyHistoryItem,
  carePlanItemRow,
  careGoalItem,
  genomicVariantItem,
  imagingStudyItem,
  opticalPrescriptionItem,
  dentalProcedureItem,
  appointmentItem,
  medicationItem,
  bodyItems,
  providerItems,
  usesAnalyteGrid,
  type ImportTab,
  type ProducedItem,
} from "@/lib/import-browser";
import {
  parseImportReport,
  summarizeCoverage,
  groupDropsByReason,
  collapseDrops,
  rowDropCount,
  isRowDrop,
  unmappedCodeIssueUrl,
  unresolvedNameIssueUrl,
} from "@/lib/import-report";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  processing:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  pending: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  skipped: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

// The read-only rows for one non-medical_records tab: the profile-scoped,
// document-traced DB read for the tab's kind, mapped through its pure shaper.
function listingItems(
  tab: ImportTab,
  profileId: number,
  docId: number,
  weightUnit: "kg" | "lb"
): ProducedItem[] {
  switch (tab.kind) {
    case "visits":
      return getDocumentVisits(profileId, docId).map(visitItem);
    case "conditions":
      return getDocumentConditions(profileId, docId).map(conditionItem);
    case "allergies":
      return getDocumentAllergies(profileId, docId).map(allergyItem);
    case "immunizations":
      return getDocumentImmunizations(profileId, docId).map(immunizationItem);
    case "procedures":
      return getDocumentProcedures(profileId, docId).map(procedureItem);
    case "family-history":
      return getDocumentFamilyHistory(profileId, docId).map(familyHistoryItem);
    case "care-plan":
      return getDocumentCarePlanItems(profileId, docId).map(carePlanItemRow);
    case "care-goals":
      return getDocumentCareGoals(profileId, docId).map(careGoalItem);
    case "genomic-variants":
      return getDocumentGenomicVariants(profileId, docId).map(
        genomicVariantItem
      );
    case "imaging-studies":
      return getDocumentImagingStudies(profileId, docId).map(imagingStudyItem);
    case "optical-prescriptions":
      return getDocumentOpticalPrescriptions(profileId, docId).map(
        opticalPrescriptionItem
      );
    case "dental-procedures":
      return getDocumentDentalProcedures(profileId, docId).map(
        dentalProcedureItem
      );
    case "appointments":
      return getDocumentAppointments(profileId, docId).map(appointmentItem);
    case "medications":
      return getDocumentMedications(profileId, docId).map(medicationItem);
    case "body":
      return bodyItems(getDocumentBodyRows(profileId, docId), weightUnit);
    case "records":
      return []; // records tabs render the records table, not a listing
    case "providers":
      return []; // providers render ProducedProviders (needs the whole set to disambiguate)
  }
}

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

// Import detail: for one uploaded document — provenance, a tabbed per-category
// records browser (#271: one tab per produced type, ?tab=-selected; record tabs
// render the analyte grid for lab/biomarker/genomics and a read-only value/date
// table for vitals/scan/instrument/derived/reference (#1182), the rest read-only
// deep-linking listings, providers their own per-document listing (#1182/#275)),
// basic debug (error + raw extraction), reprocess/delete.
export default async function ImportDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    range?: string;
    q?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const { login, profile } = await requireSession();
  const id = Number(params.id);
  const doc = id ? getMedicalDocument(profile.id, id) : undefined;
  if (!doc) notFound();

  // The tabbed records browser (#271): one tab per non-empty produced type,
  // built from the SAME counts source the toast/extracted_count uses (#212);
  // ?tab= selects the panel, defaulting to the first non-empty tab.
  const counts = getDocumentProduced(profile.id, id);
  const strip = buildImportTabs(counts);
  const total = producedTotal(counts);
  // Reconcile the extracted_count SNAPSHOT against the LIVE row count (#1339). When
  // rows have left the document (delete / merge / reassign) the snapshot exceeds
  // `total`, and the bare "produced no records" copy contradicts the count the feed
  // shows — so surface the drift explicitly. Same pure model the Review feed uses.
  const producedReconciliation = reconcileProduced(doc.extracted_count, total);
  const reconciliationLine = detailReconciliationLine(producedReconciliation);
  const activeTab = resolveImportTab(strip.tabs, searchParams.tab);
  const mismatch = isProvenanceMismatch(doc.patient_name, [
    getUserFullName(profile.id),
    profile.name,
  ]);
  const raw = formatRawExtraction(doc.raw_extraction);
  // Import DEBUGGER report: what the parse DROPPED + why, and
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
  // The AI path's parallel: labs whose canonical NAME matched no curated entry, so
  // they imported under their raw name with no reference band (#918 §4). Kept, like
  // unmapped LOINCs — not a drop.
  const unresolvedNames = report?.unresolvedNames ?? [];
  // Source-text reconciliation (AI PDF path): rows the report's own text/OCR could
  // not corroborate. A review signal, not a proven error.
  const reconciliation = report?.reconciliation ?? null;
  const isTerminalIssue =
    doc.extraction_status === "failed" || doc.extraction_status === "skipped";
  const hasExtractionError = isTerminalIssue && !!doc.extraction_error;
  // "Move to profile…" targets: the login's OTHER accessible profiles (admins see
  // all; members only their granted set). Shown only when there's somewhere to
  // move to (≥2 accessible profiles).
  const reassignTargets = (await getAccessibleProfiles())
    .filter((p) => p.id !== profile.id)
    .map((p) => ({ id: p.id, name: p.name }));

  // Records-tab filters (folded in from the old /medical/[id] view): the
  // editable table's SearchParams-driven range/q/sort filters. The old
  // ?category= filter collapsed into the tab strip — a records tab scopes the
  // query to its own category. All reads stay profile-scoped.
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
  const records =
    activeTab?.kind === "records"
      ? getRecordsForDocument(profile.id, id, {
          category: activeTab.category,
          range,
          q,
          sort,
          dir,
        })
      : [];
  // The active non-records tab's read-only rows, shaped for display (weight in
  // the login's display unit). Providers are shaped separately below — they need
  // the whole set to disambiguate same-named rows (#531/#534).
  const items =
    activeTab && activeTab.kind !== "records" && activeTab.kind !== "providers"
      ? listingItems(
          activeTab,
          profile.id,
          id,
          getUnitPrefs(login.id).weightUnit
        )
      : [];
  // The Providers tab (#1182): the distinct global-registry providers this
  // document's rows reference, disambiguated for display. Excluded from
  // extracted_count (#212) — a separate provider-scoped read.
  const providerItemsList =
    activeTab?.kind === "providers"
      ? providerItems(getDocumentProviders(profile.id, id))
      : [];
  const canonicalOptions = getCanonicalAutocomplete(profile.id);
  // "Create a visit from this record?" (#1099), scoped to the records THIS document
  // produced: a visit-implying optical/dental/imaging row dated D with no encounter
  // that day. Read-time — an encounter imported alongside self-heals the prompt away.
  const createVisitOffersList = createVisitOffers(profile.id, undefined, id);
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
      {/* Shared provider picker options for each record's edit row. */}
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
        {/* "Create a visit from this record?" (#1099) — freshly imported
            visit-implying records with no encounter that day. */}
        <CreateVisitFromRecord
          profileId={profile.id}
          offers={createVisitOffersList}
        />

        {/* Provenance */}
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Provenance
          </h2>
          {/* Absent-pillar rule (#489/#1340): show only the fields that carry a
              value — File and Detected format are always known; document date,
              source, and patient name render only when populated, so a record-less
              doc isn't a wall of em-dashes. */}
          <ProvenanceRow label="File" value={doc.filename} />
          <ProvenanceRow
            label="Detected format"
            value={documentFormatLabel(doc)}
          />
          {doc.document_date && (
            <ProvenanceRow label="Document date" value={doc.document_date} />
          )}
          {doc.source && <ProvenanceRow label="Source" value={doc.source} />}
          {doc.patient_name && (
            <ProvenanceRow
              label="Patient named in document"
              value={doc.patient_name}
            />
          )}
          {mismatch && (
            <Notice tone="amber" icon className="mt-3">
              This document names <strong>{doc.patient_name}</strong>, which
              doesn’t match this profile ({profile.name}). Make sure it was
              imported under the right person.
            </Notice>
          )}
        </div>

        {/* What it produced (#271): the tab strip IS the summary — one tab per
            non-empty produced type (label + count), Providers as a count chip
            until #275 gives them a page — followed by the active tab's panel. */}
        <div className="card" data-testid="records-browser">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            What it produced
          </h2>
          {total === 0 ? (
            <p
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="produced-summary"
            >
              {doc.extraction_status === "processing"
                ? "Extraction is still running…"
                : (reconciliationLine ?? "This import produced no records.")}
            </p>
          ) : (
            <>
              <ImportTabStrip
                docId={id}
                tabs={strip.tabs}
                activeKey={activeTab?.key}
              />
              {reconciliationLine && (
                <p
                  className="mt-3 text-sm text-slate-500 dark:text-slate-400"
                  data-testid="produced-reconciliation"
                >
                  {reconciliationLine}
                </p>
              )}
            </>
          )}
        </div>

        {/* The active tab's panel: the records table for a medical_records
            category tab (the analyte grid for lab/biomarker/genomics, a read-only
            value/date table for the rest — #1182), the per-document Providers
            listing, or a read-only deep-linking listing for every other type. */}
        {activeTab &&
          (activeTab.kind === "records" ? (
            <ExtractedRecords
              title={activeTab.label}
              analyte={usesAnalyteGrid(activeTab.category)}
              processing={doc.extraction_status === "processing"}
              records={records}
              q={q}
              range={range}
              sort={sort}
              emptyMessage={
                q || range
                  ? "No records in this document match these filters."
                  : doc.extraction_status === "processing"
                    ? "Extraction is still running…"
                    : "No records were extracted from this document."
              }
            />
          ) : activeTab.kind === "providers" ? (
            <ProducedProviders
              title={activeTab.label}
              providers={providerItemsList}
            />
          ) : (
            <ProducedListing title={activeTab.label} items={items} />
          ))}

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
                <div className="mb-1 section-label">Sections read</div>
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
            {/* Recognized-but-ignored (#268): known section types the app
                deliberately does not import (e.g. Insurance/Payers) — listed
                separately so they never read as a missing-importer gap. */}
            {coverage.ignored.length > 0 && (
              <div className="mb-3" data-testid="coverage-ignored">
                <div className="mb-1 section-label">
                  Recognized, not imported
                </div>
                <div className="flex flex-wrap gap-2">
                  {coverage.ignored.map((c) => (
                    <span
                      key={c.key + c.title}
                      className="badge inline-flex items-center gap-1 bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
                    >
                      {c.title}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  These sections are recognized but intentionally out of scope
                  (billing / coverage details, not health readings).
                </p>
              </div>
            )}
            {coverage.notConsumed.length > 0 && (
              <div data-testid="coverage-not-consumed">
                <div className="mb-1 section-label">
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
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
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
          <div className="card" data-testid="unmapped-loincs-card">
            <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
              Unmapped lab codes ({unmappedLoincs.length})
            </h2>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              These labs <strong>are imported</strong> under their printed name
              — nothing was lost — but their LOINC has no entry in the canonical
              map, so they don’t trend with the matching biomarker or pick up
              its reference band. Add the code to{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-ink-800">
                lib/biomarker-loinc.ts
              </code>{" "}
              to canonicalize them, or report it below.{" "}
              <strong>Report unmapped code</strong> opens a{" "}
              <em>public GitHub issue</em> prefilled with only the code, name,
              and unit — never your values, dates, or personal details.
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
                  {u.unit && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {u.unit}
                    </span>
                  )}
                  {u.count > 1 && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      ×{u.count}
                    </span>
                  )}
                  <a
                    href={unmappedCodeIssueUrl(u)}
                    target="_blank"
                    rel="noopener"
                    data-testid="report-unmapped-code"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-brand-700 hover:underline dark:text-brand-400"
                  >
                    Report unmapped code{" "}
                    <IconExternalLink className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Unresolved analytes (import debugger, #918 §4): the AI path's parallel to
            unmapped lab codes — imported, but under a name that matched no curated
            entry (no LOINC to fall back on), so no reference band. */}
        {report && unresolvedNames.length > 0 && (
          <div className="card" data-testid="unresolved-names-card">
            <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
              Unresolved analytes ({unresolvedNames.length})
            </h2>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              These labs <strong>are imported</strong> under their extracted
              name — nothing was lost — but the name matched no canonical
              biomarker, so they don’t trend with a known analyte or pick up its
              reference band. Add an alias in{" "}
              <code className="rounded bg-slate-100 px-1 dark:bg-ink-800">
                lib/canonical-name.ts
              </code>{" "}
              if it’s a known analyte named differently, or curate a new entry,
              or report it below. <strong>Report unresolved analyte</strong>{" "}
              opens a <em>public GitHub issue</em> prefilled with only the name
              and unit — never your values, dates, or personal details.
            </p>
            <ul className="text-sm text-slate-600 dark:text-slate-300">
              {unresolvedNames.map((u) => (
                <li
                  key={u.name}
                  className="flex flex-wrap items-baseline gap-x-2 border-b border-black/5 py-1 last:border-0 dark:border-white/10"
                >
                  <span className="font-medium">{u.name}</span>
                  {u.unit && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {u.unit}
                    </span>
                  )}
                  {u.count > 1 && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      ×{u.count}
                    </span>
                  )}
                  <a
                    href={unresolvedNameIssueUrl(u)}
                    target="_blank"
                    rel="noopener"
                    data-testid="report-unresolved-name"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-brand-700 hover:underline dark:text-brand-400"
                  >
                    Report unresolved analyte{" "}
                    <IconExternalLink className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Source reconciliation (AI PDF path): rows the report's OWN text/OCR could
            not corroborate — a deterministic cross-check of the model's output. */}
        {reconciliation && reconciliation.flags.length > 0 && (
          <div className="card" data-testid="reconciliation-card">
            <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
              Source reconciliation ({reconciliation.confirmed}/
              {reconciliation.total} confirmed)
            </h2>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              Each extracted value was checked against the report’s own text
              (its PDF text layer, or OCR for a scanned report). The rows below{" "}
              <strong>couldn’t be corroborated</strong> — the value the model
              read isn’t next to that name in the source, or the name never
              appears. Treat these as a <strong>review signal</strong>, not a
              proven error: a report’s text can be imperfect.
            </p>
            <ul className="text-sm text-slate-600 dark:text-slate-300">
              {reconciliation.flags.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex flex-wrap items-baseline gap-x-2 border-b border-black/5 py-1 last:border-0 dark:border-white/10"
                >
                  <span className="font-medium">{f.name}</span>
                  {f.value && (
                    <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {f.value}
                    </span>
                  )}
                  <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    {f.verdict === "value_mismatch"
                      ? "value not found in source"
                      : "name not found in source"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Dropped candidates (import debugger) */}
        {report && dropGroups.length > 0 && (
          <div className="card" data-testid="dropped-card">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Dropped ({droppedRows})
            </h2>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              Itemized drops cover labs, vitals, immunizations, medications,
              allergies and problems (plus duplicates). Encounters, social
              history and some retracted resources aren’t itemized yet, and
              “imported” counts parsed rows before body-metric deferral — so
              these totals are indicative, not exhaustive. Identical rows are
              collapsed with a ×N count.
            </p>
            {/* Viewport-bounded body (#270): a real-world CCD drops hundreds of
                rows — the card scrolls internally instead of dominating the page,
                with each reason header sticky while its group scrolls by. */}
            <div
              className="max-h-[50vh] space-y-4 overflow-y-auto"
              data-testid="dropped-scroll"
            >
              {dropGroups.map((g) => (
                <div key={g.reason} data-testid="drop-group">
                  <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 rounded bg-white/90 px-1 py-1 backdrop-blur-sm dark:bg-ink-900/90">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {g.label}
                    </span>
                    <span className="badge bg-slate-100 tabular-nums text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                      {g.drops.length}
                    </span>
                  </div>
                  <ul className="space-y-0.5 text-sm text-slate-600 dark:text-slate-300">
                    {collapseDrops(g.drops).map((d) => (
                      <li
                        key={`${d.label}-${d.section ?? ""}`}
                        data-testid="drop-row"
                        className="flex flex-wrap items-baseline gap-x-2 border-b border-black/5 py-1 last:border-0 dark:border-white/10"
                      >
                        <span className="font-medium">{d.label}</span>
                        {d.section && (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {d.section}
                          </span>
                        )}
                        {d.count > 1 && (
                          <span
                            data-testid="drop-row-count"
                            className="tabular-nums text-xs text-slate-500 dark:text-slate-400"
                          >
                            ×{d.count}
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
            <DocumentPreview src={src} isPdf={isPdf} filename={doc.filename} />
          ) : doc.stored_path ? (
            // File is stored but this type can't inline-preview — one line with the
            // open-original affordance, not a prose wall (#1340).
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Inline preview isn’t available for this file type.{" "}
              <a
                href={src}
                target="_blank"
                rel="noopener"
                className="text-brand-700 hover:underline dark:text-brand-400"
              >
                Open the original
              </a>
            </p>
          ) : (
            // Nothing to show at all — collapse to a single line (#1340).
            <p className="text-sm text-slate-500 dark:text-slate-400">
              The original file isn’t stored.
            </p>
          )}
        </div>

        {/* Debug — dev-facing, so it's behind a collapsed disclosure and SELF-HIDES
            when it has nothing to say (#1340): no card at all unless there's an
            extraction error or a stored raw extraction to show. */}
        {(hasExtractionError || raw) && (
          <details className="card group" data-testid="debug-disclosure">
            <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">
              Debug
            </summary>
            <div className="mt-3 space-y-3">
              {hasExtractionError && (
                <div
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    doc.extraction_status === "failed"
                      ? "border-rose-100 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
                      : "border-black/10 bg-slate-50 text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400"
                  }`}
                >
                  {doc.extraction_error}
                </div>
              )}
              {raw && (
                <details className="group/raw">
                  <summary className="cursor-pointer text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
                    Raw extraction
                  </summary>
                  {/* The shared collapsible JSON/XML tree + copy (#1318) — a CCD/XDM
                      raw renders as a foldable element tree, an AI extraction as a
                      JSON tree, anything else as plain text. */}
                  <RawDataViewer text={doc.raw_extraction ?? raw} />
                </details>
              )}
            </div>
          </details>
        )}

        {/* Actions */}
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Actions
          </h2>
          <ImportDetailActions
            id={doc.id}
            filename={doc.filename}
            hasRaw={!!doc.raw_extraction}
            explainers={importActionExplainers({
              deterministic: isDeterministicReprocess({
                source: doc.source,
                mime_type: doc.mime_type,
              }),
              hasRaw: !!doc.raw_extraction,
            })}
          />
          {reassignTargets.length > 0 && (
            <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/10">
              <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                Wrong person?
              </h3>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Move this document — and every row it imported — to another
                profile you can access.
              </p>
              {doc.extraction_status === "processing" ? (
                // A move mid-extraction would strand the in-flight import under the
                // wrong profile (the reassignDocument action refuses it too — this
                // just hides the control until it settles).
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  This document is still processing — you can move it once
                  extraction finishes.
                </p>
              ) : (
                <ReassignDocument
                  id={doc.id}
                  filename={doc.filename}
                  destinations={reassignTargets}
                  recordCount={total}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
