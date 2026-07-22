"use client";

import { IconRefresh, IconLoader2 } from "@tabler/icons-react";
import Link from "next/link";
import type { MedicalRecord } from "@/lib/types";
import { groupContiguous } from "@/lib/table-sort";
import { recordNameLink } from "@/lib/import-browser";
import { EmptyState, MedicalValue } from "./ui";
import NotesText from "./NotesText";
import EditableRecordRow from "./EditableRecordRow";
import RangeFilterSelect from "./RangeFilterSelect";
import SortableHeader from "./SortableHeader";
import RecordSearch from "./RecordSearch";
import { useReprocessDocument } from "@/components/useReprocessDocument";

// The grouping identity for a record: its canonical name when present, else the
// raw name — the same key the biomarkers table groups on, so name-sorted rows
// for the same analyte land adjacent under one heading.
function nameKey(r: MedicalRecord): string {
  return r.canonical_name?.trim() || r.name;
}

// One read-only row of the NON-ANALYTE presentation (#1182): a vitals BP pair, a
// scan, a PHQ-9 score, a bio-age, a blood type — categories with no lab reference
// band and no "Panel", so they get a compact value/date table with no editable
// affordance (the analyte columns don't apply). The name still links where the
// category has a home (vitals → biomarker series; scan/instrument/derived/
// reference get no link, per recordNameLink).
function ReadonlyRecordRow({ record: r }: { record: MedicalRecord }) {
  const nameLink = recordNameLink(r.category, r.canonical_name);
  return (
    <tr className="border-b border-black/5 dark:border-white/10">
      <td className="td font-medium">
        {nameLink ? (
          <Link
            href={nameLink.href}
            className="text-brand-700 hover:underline dark:text-brand-400"
            title={nameLink.title}
          >
            {r.name}
          </Link>
        ) : (
          r.name
        )}
        {r.provider_name ? (
          <div className="text-xs font-normal text-slate-500 dark:text-slate-400">
            {r.provider_id ? (
              <Link
                href={`/providers/${r.provider_id}`}
                className="hover:text-brand-700 hover:underline dark:hover:text-brand-300"
              >
                {r.provider_name}
              </Link>
            ) : (
              r.provider_name
            )}
          </div>
        ) : null}
      </td>
      <td className="td">
        <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
      </td>
      <td className="td text-slate-500 dark:text-slate-400">
        <NotesText notes={r.notes} />
      </td>
      <td className="td whitespace-nowrap">{r.date}</td>
    </tr>
  );
}

// The records table for one medical_records category tab of the import-detail
// records browser (#271): the old CategoryFilterSelect collapsed into the tab
// strip, so the host passes the tab's label as `title` and scopes the records
// itself. Its reprocess button shares the useReprocessDocument hook with the
// documents-list row button, which flips the document to 'processing' and runs
// extraction in the background. The action returns immediately; a "Processing…"
// overlay stays over the table for the whole time the document is `processing`
// (from this reprocess, or a first upload extraction viewed here), and the
// app-wide ExtractionToaster refreshes the page and toasts when the background
// job finishes (clearing it).
//
// Presentation splits by category (#1182): analyte categories (lab/biomarker/
// genomics) keep the editable analyte grid — Name · Panel · Value · Reference · …
// — because those legitimately carry a value/unit/reference band; every other
// category (vitals/scan/instrument/derived/reference) gets the read-only compact
// value/date table above, with no Panel/Reference columns and no edit affordance.
export default function ExtractedRecords({
  docId,
  filename,
  title = "Extracted records",
  analyte,
  processing,
  records,
  q,
  range,
  sort,
  emptyMessage,
}: {
  docId: number;
  filename: string;
  // Heading for the table — the active tab's label ("Labs", "Vitals"…).
  title?: string;
  // Whether this tab's category carries the analyte grammar (value/unit/reference
  // band). True → the editable analyte grid; false → the read-only value/date
  // table. Decided by isAnalyteCategory in lib/import-browser.
  analyte: boolean;
  // The document's extraction is still running (from upload or a prior
  // reprocess). Reprocessing now would race that in-flight job, so we show a
  // spinner instead of the reprocess button.
  processing: boolean;
  records: MedicalRecord[];
  q?: string;
  range?: "oor" | "nonoptimal";
  // Active sort column, so we know whether to render contiguous name groups
  // (only when the table is name-sorted, matching the biomarkers table).
  sort: "name" | "panel" | "date";
  emptyMessage: string;
}) {
  const { pending, reprocess } = useReprocessDocument(docId, filename);

  // Group contiguous same-name rows only when name-sorted AND on the analyte
  // grid (rows already arrive adjacent by name from the query); the read-only
  // non-analyte table renders flat (its rows are heterogeneous, not one analyte).
  const grouped =
    analyte && sort === "name" ? groupContiguous(records, nameKey) : null;

  return (
    <div className="card mb-6 overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-4 px-5 pt-5">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {title}{" "}
          <span className="font-normal text-slate-500 dark:text-slate-400">
            ({records.length})
          </span>
        </h2>
        <RecordSearch q={q} />
        {/* The out-of-range filter keys on a reference band — analyte-only. */}
        {analyte && <RangeFilterSelect value={range} />}
        {processing ? (
          <IconLoader2
            className="ml-auto h-4 w-4 animate-spin text-slate-500 motion-reduce:animate-none dark:text-slate-400"
            aria-label="Processing"
          />
        ) : (
          <button
            type="button"
            onClick={reprocess}
            disabled={pending}
            title="Reprocess document"
            aria-label="Reprocess document"
            className="ml-auto text-slate-500 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:text-brand-400"
          >
            <IconRefresh className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="relative">
        {records.length === 0 ? (
          <div className="p-5">
            <EmptyState message={emptyMessage} />
          </div>
        ) : (
          <div className="mt-3 max-h-[70vh] overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <SortableHeader
                    column="name"
                    label="Name"
                    defaultSort="name"
                  />
                  {analyte && (
                    <SortableHeader
                      column="panel"
                      label="Panel"
                      defaultSort="name"
                    />
                  )}
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Value
                  </th>
                  {analyte && (
                    <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                      Reference
                    </th>
                  )}
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Notes
                  </th>
                  {analyte && (
                    <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                      Category
                    </th>
                  )}
                  <SortableHeader
                    column="date"
                    label="Date"
                    defaultSort="name"
                    defaultDir="desc"
                  />
                  {analyte && (
                    <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {!analyte
                  ? records.map((r) => (
                      <ReadonlyRecordRow key={r.id} record={r} />
                    ))
                  : grouped
                    ? grouped.map(({ row: r, isGroupStart, isGroupEnd }) => (
                        <EditableRecordRow
                          key={r.id}
                          record={r}
                          grouped={{ isGroupStart, isGroupEnd }}
                        />
                      ))
                    : records.map((r) => (
                        <EditableRecordRow key={r.id} record={r} />
                      ))}
              </tbody>
            </table>
          </div>
        )}

        {(pending || processing) && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/70 dark:bg-ink-900/70">
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
              Processing…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
