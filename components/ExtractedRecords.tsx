"use client";

import { IconRefresh, IconLoader2 } from "@tabler/icons-react";
import type { MedicalRecord } from "@/lib/types";
import { groupContiguous } from "@/lib/table-sort";
import { EmptyState } from "./ui";
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

// The editable records table for one medical_records category tab of the
// import-detail records browser (#271): the old CategoryFilterSelect collapsed
// into the tab strip, so the host passes the tab's label as `title` and scopes
// the records itself. Its reprocess button shares the useReprocessDocument hook
// with the documents-list row button, which flips the document to 'processing'
// and runs extraction in the background. The action returns immediately; a
// "Processing…" overlay stays over the table for the whole time the document is
// `processing` (from this reprocess, or a first upload extraction viewed here),
// and the app-wide ExtractionToaster refreshes the page and toasts when the
// background job finishes (clearing it).
export default function ExtractedRecords({
  docId,
  filename,
  title = "Extracted records",
  processing,
  records,
  q,
  range,
  sort,
  emptyMessage,
}: {
  docId: number;
  filename: string;
  // Heading for the table — the active tab's label ("Labs", "Prescriptions"…).
  title?: string;
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

  // Group contiguous same-name rows only when name-sorted (rows already arrive
  // adjacent by name from the query); other sorts render flat. Reuses the shared
  // groupContiguous helper the biomarkers/documents tables use.
  const grouped = sort === "name" ? groupContiguous(records, nameKey) : null;

  return (
    <div className="card mb-6 overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-4 px-5 pt-5">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {title}{" "}
          <span className="font-normal text-slate-400 dark:text-slate-500">
            ({records.length})
          </span>
        </h2>
        <RecordSearch q={q} />
        <RangeFilterSelect value={range} />
        {processing ? (
          <IconLoader2
            className="ml-auto h-4 w-4 animate-spin text-slate-400 dark:text-slate-500"
            aria-label="Processing"
          />
        ) : (
          <button
            type="button"
            onClick={reprocess}
            disabled={pending}
            title="Reprocess document"
            aria-label="Reprocess document"
            className="ml-auto text-slate-400 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-500 dark:hover:text-brand-400"
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
                  <SortableHeader
                    column="panel"
                    label="Panel"
                    defaultSort="name"
                  />
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Value
                  </th>
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Reference
                  </th>
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Notes
                  </th>
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Category
                  </th>
                  <SortableHeader
                    column="date"
                    label="Date"
                    defaultSort="name"
                    defaultDir="desc"
                  />
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {grouped
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
